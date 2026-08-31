import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractLlamaTiming, summarizeLlamaTiming, type LlamaTiming } from "@/lib/llama-timing";

const baseUrl = (process.env.LLAMA_CPP_BASE_URL ?? "http://127.0.0.1:8082").replace(/\/$/, "");
const model = process.env.LLAMA_CPP_MODEL ?? "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf";
const apiKey = process.env.LLAMA_CPP_API_KEY ?? "";
const runsPerQuestion = Math.max(1, Number(process.env.LLAMA_TIMING_RUNS ?? 3));
const outputDir = path.resolve(process.env.LLAMA_TIMING_OUTPUT ?? path.join(process.cwd(), "reports", "performance-resilience", `llama-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const questions = [
  "KV Cache 是什么，为什么能加速推理？",
  "LoRA 和全量微调有什么区别？",
  "RAG 检索增强生成的基本流程是什么？",
  "vLLM 里的 continuous batching 如何提升吞吐？",
  "PagedAttention 解决了什么问题？",
  "MoE 混合专家架构的核心思想是什么？",
  "Speculative decoding 的加速原理是什么？",
  "FlashAttention 相比标准注意力改进了哪里？",
];

interface RunRecord { questionId: string; run: number; status: string; firstEventMs: number | null; firstTokenMs: number | null; completionMs: number; timing: LlamaTiming | null; error?: string }

async function measure(question: string, questionId: string, run: number): Promise<RunRecord> {
  const started = performance.now();
  let firstEventMs: number | null = null;
  let firstTokenMs: number | null = null;
  const timingPayloads: unknown[] = [];
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "system", content: "只回答一个简短定义，输出纯文本，不要 Markdown。" }, { role: "user", content: question }], temperature: 0, max_tokens: 128, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const raw = trimmed.slice(5).trim();
      if (raw === "[DONE]") return;
      let payload: unknown;
      try { payload = JSON.parse(raw) as unknown; } catch { return; }
      timingPayloads.push(payload);
      if (firstEventMs === null) firstEventMs = performance.now() - started;
      if (payload && typeof payload === "object") {
        const choices = (payload as Record<string, unknown>).choices;
        const choice = Array.isArray(choices) ? choices[0] : null;
        const delta = choice && typeof choice === "object" ? (choice as Record<string, unknown>).delta : null;
        if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string" && String((delta as Record<string, unknown>).content).length > 0 && firstTokenMs === null) firstTokenMs = performance.now() - started;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) { for (const line of buffer.slice(0, split).split("\n")) consume(line); buffer = buffer.slice(split + 2); split = buffer.indexOf("\n\n"); }
    }
    for (const line of buffer.split("\n")) consume(line);
    const timing = timingPayloads.map(extractLlamaTiming).find((value): value is LlamaTiming => value !== null) ?? null;
    return { questionId, run, status: "ok", firstEventMs, firstTokenMs, completionMs: performance.now() - started, timing };
  } catch (error) {
    return { questionId, run, status: "failed", firstEventMs, firstTokenMs, completionMs: performance.now() - started, timing: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function percentile(values: number[], p: number): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]; }

async function main(): Promise<void> {
  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`llama health HTTP ${health.status}`);
  const runs: RunRecord[] = [];
  for (const [index, question] of questions.entries()) {
    for (let run = 1; run <= runsPerQuestion; run += 1) {
      const result = await measure(question, `q${index + 1}`, run);
      runs.push(result);
      console.log(`[${runs.length}/${questions.length * runsPerQuestion}] ${result.status} firstToken=${result.firstTokenMs === null ? "-" : Math.round(result.firstTokenMs)}ms completion=${Math.round(result.completionMs)}ms`);
    }
  }
  const ok = runs.filter((run) => run.status === "ok");
  const timings = ok.map((run) => run.timing).filter((value): value is LlamaTiming => value !== null);
  const summary = { total: runs.length, succeeded: ok.length, failed: runs.length - ok.length, firstEventP50Ms: percentile(ok.map((run) => run.firstEventMs).filter((value): value is number => value !== null), 0.5), firstEventP95Ms: percentile(ok.map((run) => run.firstEventMs).filter((value): value is number => value !== null), 0.95), firstTokenP50Ms: percentile(ok.map((run) => run.firstTokenMs).filter((value): value is number => value !== null), 0.5), firstTokenP95Ms: percentile(ok.map((run) => run.firstTokenMs).filter((value): value is number => value !== null), 0.95), completionP50Ms: percentile(ok.map((run) => run.completionMs), 0.5), completionP95Ms: percentile(ok.map((run) => run.completionMs), 0.95), timing: summarizeLlamaTiming(timings) };
  const manifest = { evaluator: "llama-timing-evaluator-v1", generatedAt: new Date().toISOString(), baseUrl, model, runsPerQuestion, questionCount: questions.length, executionMode: "real_llama_cpp_sse", timingFieldPolicy: "server_timings_only", evidenceBoundary: "Real llama.cpp SSE timing for a fixed prompt set; firstToken is upstream SSE content when exposed, while buffered application answer bytes are not TTFT." };
  const failures = runs.filter((run) => run.status !== "ok");
  const scorecard = { evaluator: manifest.evaluator, status: failures.length === 0 && timings.length > 0 ? "complete" : "partial", denominator: { total: runs.length, succeeded: ok.length, failed: failures.length, timingAvailable: timings.length }, summary, evidenceBoundary: manifest.evidenceBoundary };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "cases.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n"),
    writeFile(path.join(outputDir, "failures.jsonl"), failures.map((run) => JSON.stringify(run)).join("\n") + (failures.length ? "\n" : "")),
    writeFile(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(path.join(outputDir, "report.md"), `# llama.cpp timing report\n\n- Status: ${scorecard.status}\n- Success/failed: ${ok.length}/${failures.length}\n- First upstream token P50/P95: ${summary.firstTokenP50Ms ?? "null"}/${summary.firstTokenP95Ms ?? "null"} ms\n- Completion P50/P95: ${summary.completionP50Ms ?? "null"}/${summary.completionP95Ms ?? "null"} ms\n- tok/s timing samples: ${timings.length}\n- Evidence: ${manifest.evidenceBoundary}\n`),
  ]);
  console.log(`llama timing report written to ${outputDir}`);
  if (scorecard.status !== "complete") process.exitCode = 1;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
