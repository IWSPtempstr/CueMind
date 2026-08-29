// P0 先测后判（决策 67）：在当前模型基线上实测会中询问的首字节与完成延迟。
// 背景：A 阶段验收完成 P95=11.47s 超 7s 预算；基线切 8B 后仅复测过首字节，
// 完成 P95 未复测——本脚本补该测量，结果决定缺陷关闭或进入修复。
//
// 口径（与计划一致）：冻结题集 8 题；单题串行（避免询问让位干扰单题测量）；
// 真实垂直源搜索；P95 线性插值。题集冻结于 2026-08-29，不得按结果调整。
//
// 用法：先确保 :3000 dev server 与本地 llama 服务健康，然后
//   npx tsx scripts/measure-ask-latency.ts

const BASE_URL = process.env.ASK_MEASURE_BASE_URL ?? "http://localhost:3000";
const PER_QUESTION_TIMEOUT_MS = 60_000;
const COMPLETION_BUDGET_MS = 7_000; // 决策 67：完成 P95 ≤7s
const FIRST_BYTE_BUDGET_MS = 3_000; // 决策 67：首字节 ≤3s

// 冻结题集（2026-08-29 锁定）：中英术语混合，贴近 AI 技术会议真实问法。
const FROZEN_QUESTIONS = [
  "KV Cache 是什么，为什么能加速推理？",
  "LoRA 和全量微调有什么区别？",
  "RAG 检索增强生成的基本流程是什么？",
  "vLLM 里的 continuous batching 怎么提升吞吐？",
  "PagedAttention 解决了什么问题？",
  "MoE 混合专家架构的核心思想是什么？",
  "Speculative decoding 的加速原理是什么？",
  "FlashAttention 相比标准注意力改进了哪里？",
];

// 预热问题：不在题集内（不污染题集的搜索缓存），仅用于消除 dev 路由懒编译
// 与首请求冷启动开销——这类开销不属于生产环境的询问延迟。
const WARMUP_QUESTION = "Transformer 的注意力机制是什么？";

// 固定只读转写上下文（模拟真实请求形态；从不外发，仅本地生成上下文）。
const RECENT_TRANSCRIPT = [
  "我们今天讨论大模型推理优化，先看一下 KV Cache 的显存占用。",
  "有同事提到可以用 PagedAttention 来缓解碎片化。",
  "另外 LoRA 微调后的模型在长上下文下表现如何也值得评估。",
].join("\n");

interface Stages {
  keywordMs: number;
  searchMs: number;
  generationMs: number;
}

interface MeasureResult {
  question: string;
  finalState: string;
  /** 首个 SSE 事件（searching 等）——与 A/B 报告的「首字节」口径可比。 */
  firstEventMs: number | null;
  /** 首个 answer_chunk/degraded——服务端缓冲校验设计下 ≈ 完成时间。 */
  firstByteMs: number | null;
  completionMs: number;
  stages: Stages | null;
  error: string | null;
}

async function measureOne(question: string): Promise<MeasureResult> {
  const startedAt = performance.now();
  let firstEventMs: number | null = null;
  let firstByteMs: number | null = null;
  let completionMs = 0;
  let finalState = "";
  let stages: Stages | null = null;

  const response = await fetch(`${BASE_URL}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, recentTranscript: RECENT_TRANSCRIPT }),
    signal: AbortSignal.timeout(PER_QUESTION_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    return {
      question,
      finalState: "http_error",
      firstEventMs: null,
      firstByteMs: null,
      completionMs: performance.now() - startedAt,
      stages: null,
      error: `HTTP ${response.status}`,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const event = typeof data.event === "string" ? data.event : "";
    if (firstEventMs === null) {
      firstEventMs = performance.now() - startedAt;
    }
    if ((event === "answer_chunk" || event === "degraded") && firstByteMs === null) {
      firstByteMs = performance.now() - startedAt;
    }
    if (event === "done") {
      completionMs = performance.now() - startedAt;
      finalState = typeof data.finalState === "string" ? data.finalState : "";
      const rawStages = data.stages;
      if (typeof rawStages === "object" && rawStages !== null) {
        const record = rawStages as Record<string, unknown>;
        stages = {
          keywordMs: typeof record.keywordMs === "number" ? record.keywordMs : 0,
          searchMs: typeof record.searchMs === "number" ? record.searchMs : 0,
          generationMs: typeof record.generationMs === "number" ? record.generationMs : 0,
        };
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      for (const line of block.split("\n")) processLine(line);
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
  for (const line of buffer.split("\n")) processLine(line);

  if (completionMs === 0) completionMs = performance.now() - startedAt;
  return { question, finalState: finalState || "no_done", firstEventMs, firstByteMs, completionMs, stages, error: null };
}

/** 线性插值分位数（与 evaluate-context-cards.ts 口径一致）。 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = p * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (rank - lower);
}

function summarize(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

async function main(): Promise<void> {
  // 预热一轮（结果丢弃）：消除 dev 懒编译/冷启动对首题的测量污染。
  try {
    await measureOne(WARMUP_QUESTION);
    process.stdout.write("warmup done（结果不计入统计）\n");
  } catch {
    process.stdout.write("warmup failed（继续测量）\n");
  }

  const results: MeasureResult[] = [];
  for (const [index, question] of FROZEN_QUESTIONS.entries()) {
    let result: MeasureResult;
    try {
      result = await measureOne(question);
    } catch (caught) {
      result = {
        question,
        finalState: "fetch_error",
        firstEventMs: null,
        firstByteMs: null,
        completionMs: 0,
        stages: null,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
    results.push(result);
    const firstByte = result.firstByteMs !== null ? `${Math.round(result.firstByteMs)}ms` : "-";
    const firstEvent = result.firstEventMs !== null ? `${Math.round(result.firstEventMs)}ms` : "-";
    const stages = result.stages;
    const stagesText =
      stages !== null
        ? `kw=${stages.keywordMs} search=${stages.searchMs} gen=${stages.generationMs}`
        : result.error ?? "";
    process.stdout.write(
      `[${index + 1}/${FROZEN_QUESTIONS.length}] state=${result.finalState} firstEvent=${firstEvent} firstByte=${firstByte} ` +
        `completion=${Math.round(result.completionMs)}ms (${stagesText}) ${result.question}\n`,
    );
  }

  const ok = results.filter((result) => result.error === null);
  const firstEventValues = ok
    .map((result) => result.firstEventMs)
    .filter((value): value is number => value !== null);
  const firstByteValues = ok
    .map((result) => result.firstByteMs)
    .filter((value): value is number => value !== null);
  const completionValues = ok.map((result) => result.completionMs);

  const firstEventStats = summarize(firstEventValues);
  const firstByteStats = summarize(firstByteValues);
  const completionStats = summarize(completionValues);
  const stageAvg = (key: keyof Stages): number => {
    const values = ok.map((result) => result.stages?.[key]).filter((v): v is number => typeof v === "number");
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
  };

  process.stdout.write("\n=== 会中询问延迟实测（冻结题集 8 题，串行，真实搜索） ===\n");
  process.stdout.write(`成功 ${ok.length}/${results.length} 题（degraded/invalid 计入完成时间）\n`);
  process.stdout.write(
    `首事件（searching，A/B 口径首字节）：P50=${Math.round(firstEventStats.p50)}ms P95=${Math.round(firstEventStats.p95)}ms（预算 ≤${FIRST_BYTE_BUDGET_MS}ms）` +
      `${firstEventStats.p95 <= FIRST_BYTE_BUDGET_MS ? " ✅" : " ❌"}\n`,
  );
  process.stdout.write(
    `答案首字节（受服务端缓冲校验设计约束）：P50=${Math.round(firstByteStats.p50)}ms P95=${Math.round(firstByteStats.p95)}ms\n`,
  );
  process.stdout.write(
    `完成：P50=${Math.round(completionStats.p50)}ms P95=${Math.round(completionStats.p95)}ms（预算 ≤${COMPLETION_BUDGET_MS}ms）` +
      `${completionStats.p95 <= COMPLETION_BUDGET_MS ? " ✅" : " ❌"}\n`,
  );
  process.stdout.write(
    `stages 均值：keyword=${Math.round(stageAvg("keywordMs"))}ms search=${Math.round(stageAvg("searchMs"))}ms ` +
      `generation=${Math.round(stageAvg("generationMs"))}ms\n`,
  );
  process.stdout.write(
    `判定：${completionStats.p95 <= COMPLETION_BUDGET_MS ? "完成 P95 达标，缺陷关闭" : "完成 P95 超标，需按 stages 分解修复"}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
