import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequestTimeline, type RequestTimelineEvent } from "@/lib/request-timeline";

const baseUrl = (process.env.ASK_MEASURE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outputDir = path.resolve(process.env.REQUEST_TIMELINE_OUTPUT ?? path.join(process.cwd(), "reports", "performance-resilience", `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const questions = [
  "KV Cache 是什么，为什么能加速推理？",
  "RAG 检索增强生成的基本流程是什么？",
  "PagedAttention 解决了什么问题？",
];
const recentTranscript = "我们今天讨论大模型推理优化，先看一下 KV Cache 的显存占用。";

interface TimelineCase { runId: string; questionId: string; status: string; timeline: ReturnType<typeof createRequestTimeline>; stages: Record<string, number | null>; missingEvents: string[]; derivedEvents: string[]; error?: string }

async function measure(question: string, index: number): Promise<TimelineCase> {
  const started = performance.now();
  const events: RequestTimelineEvent[] = [{ name: "request_start", atMs: 0 }];
  const observed: Set<string> = new Set();
  let buffer = "";
  let firstEventMs: number | null = null;
  let firstTokenMs: number | null = null;
  let completeMs: number | null = null;
  let finalState = "no_done";
  let stages: Record<string, number | null> = { keywordMs: null, searchMs: null, generationMs: null };
  const runId = `timeline-${Date.now()}-${index + 1}`;
  const add = (name: RequestTimelineEvent["name"], atMs: number, isObserved = true): void => { events.push({ name, atMs: Math.max(0, Math.round(atMs)) }); if (isObserved) observed.add(name); };
  try {
    const response = await fetch(`${baseUrl}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, recentTranscript }), signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const raw = trimmed.slice(5).trim();
      if (raw === "[DONE]") return;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      const atMs = performance.now() - started;
      if (firstEventMs === null) { firstEventMs = atMs; add("first_event", atMs); }
      const event = typeof payload.event === "string" ? payload.event : "";
      if (event === "searching") add("search_start", atMs);
      if ((event === "answer_chunk" || event === "degraded") && firstTokenMs === null) { firstTokenMs = atMs; add("first_token", atMs); }
      if (event === "done") {
        completeMs = atMs;
        finalState = typeof payload.finalState === "string" ? payload.finalState : "no_done";
        const rawStages = payload.stages;
        if (rawStages && typeof rawStages === "object") {
          const value = rawStages as Record<string, unknown>;
          stages = { keywordMs: typeof value.keywordMs === "number" ? value.keywordMs : null, searchMs: typeof value.searchMs === "number" ? value.searchMs : null, generationMs: typeof value.generationMs === "number" ? value.generationMs : null };
        }
        add("complete", atMs);
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
  } catch (error) {
    return { runId, questionId: `q${index + 1}`, status: "failed", timeline: createRequestTimeline(runId, [{ name: "request_start", atMs: 0 }, { name: "complete", atMs: performance.now() - started }], "failed"), stages, missingEvents: ["first_event", "first_token", "capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end", "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end"], derivedEvents: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (completeMs === null) completeMs = performance.now() - started;
  if (stages.generationMs !== null) { add("generation_end", completeMs, false); add("generation_start", completeMs - stages.generationMs, false); }
  if (stages.searchMs !== null && stages.generationMs !== null) add("search_end", completeMs - stages.generationMs, false);
  const timeline = createRequestTimeline(runId, events, finalState);
  const allNames = ["capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end", "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end", "first_event", "first_token", "complete"];
  const present = new Set<string>(events.map((event) => event.name));
  return { runId, questionId: `q${index + 1}`, status: finalState, timeline, stages, missingEvents: allNames.filter((name) => !present.has(name)), derivedEvents: events.filter((event) => !observed.has(event.name)).map((event) => event.name) };
}

async function main(): Promise<void> {
  const cases: TimelineCase[] = [];
  for (const [index, question] of questions.entries()) cases.push(await measure(question, index));
  const failures = cases.filter((item) => item.status === "failed");
  const manifest = { evaluator: "request-timeline-evaluator-v1", generatedAt: new Date().toISOString(), baseUrl, questionCount: questions.length, executionMode: "real_ask_sse", evidenceBoundary: "Observed SSE boundaries plus explicitly marked stage-time derivations. Ask route does not expose capture/ASR/render events, so missing fields remain null." };
  const scorecard = { evaluator: manifest.evaluator, status: failures.length === 0 ? "complete" : "partial", denominator: { total: cases.length, succeeded: cases.length - failures.length, failed: failures.length }, missingEventCounts: cases.reduce<Record<string, number>>((counts, item) => { for (const name of item.missingEvents) counts[name] = (counts[name] ?? 0) + 1; return counts; }, {}), evidenceBoundary: manifest.evidenceBoundary };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "cases.jsonl"), cases.map((item) => JSON.stringify(item)).join("\n") + "\n"),
    writeFile(path.join(outputDir, "failures.jsonl"), failures.map((item) => JSON.stringify(item)).join("\n") + (failures.length ? "\n" : "")),
    writeFile(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(path.join(outputDir, "report.md"), `# Request timeline report\n\n- Status: ${scorecard.status}\n- Success/failed: ${scorecard.denominator.succeeded}/${scorecard.denominator.failed}\n- Missing events: ${JSON.stringify(scorecard.missingEventCounts)}\n- Evidence: ${manifest.evidenceBoundary}\n`),
  ]);
  console.log(`Request timeline report written to ${outputDir}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
