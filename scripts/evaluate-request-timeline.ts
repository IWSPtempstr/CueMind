import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequestTimeline, getStageDurations, REQUEST_TIMELINE_EVENTS, type PipelineEvent, type RequestTimelineEvent } from "@/lib/request-timeline";

const baseUrl = (process.env.ASK_MEASURE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outputDir = path.resolve(process.env.REQUEST_TIMELINE_OUTPUT ?? path.join(process.cwd(), "reports", "performance-resilience", `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const questions = [
  "KV Cache 是什么，为什么能加速推理？",
  "RAG 检索增强生成的基本流程是什么？",
  "PagedAttention 解决了什么问题？",
];
const recentTranscript = "我们今天讨论大模型推理优化，先看一下 KV Cache 的显存占用。";

interface TimelineCase { runId: string; questionId: string; status: string; timeline: ReturnType<typeof createRequestTimeline>; stages: Record<string, number | null>; nativeEvents: PipelineEvent[]; missingEvents: string[]; derivedEvents: string[]; error?: string }

async function measure(question: string, index: number): Promise<TimelineCase> {
  const started = performance.now();
  const events: RequestTimelineEvent[] = [{ name: "request_start", atMs: 0 }];
  const observed: Set<string> = new Set();
  const nativeEvents: PipelineEvent[] = [];
  let buffer = "";
  let firstEventMs: number | null = null;
  let firstTokenMs: number | null = null;
  let completeMs: number | null = null;
  let finalState = "no_done";
  let stages: Record<string, number | null> = { keywordMs: null, searchMs: null, generationMs: null };
  const runId = `timeline-${Date.now()}-${index + 1}`;
  const add = (name: RequestTimelineEvent["name"], atMs: number, isObserved = true): void => { events.push({ name, atMs: Math.max(0, Math.round(atMs)) }); if (isObserved) observed.add(name); };
  const addNative = (event: PipelineEvent): void => {
    if (event.runId !== runId || !REQUEST_TIMELINE_EVENTS.includes(event.name) || nativeEvents.some((item) => item.name === event.name)) return;
    nativeEvents.push(event);
    add(event.name, event.atMs, true);
  };
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
      if (event === "pipeline_event" && typeof payload.pipelineEvent === "object" && payload.pipelineEvent !== null) {
        const candidate = payload.pipelineEvent as PipelineEvent;
        if (typeof candidate.name === "string" && typeof candidate.runId === "string" && typeof candidate.atMs === "number") addNative(candidate);
      }
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
        // Complete is appended after derived stage boundaries below so strict
        // timeline validation never sees a retrograde generation_start.
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
    return { runId, questionId: `q${index + 1}`, status: "failed", timeline: createRequestTimeline(runId, [{ name: "request_start", atMs: 0 }, { name: "complete", atMs: performance.now() - started }], "failed"), stages, nativeEvents, missingEvents: ["first_event", "first_token", "capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end", "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end"], derivedEvents: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (completeMs === null) completeMs = performance.now() - started;
  if (stages.generationMs !== null) { add("generation_end", completeMs, false); add("generation_start", completeMs - stages.generationMs, false); }
  if (stages.searchMs !== null && stages.generationMs !== null) add("search_end", completeMs - stages.generationMs, false);
  add("complete", completeMs);
  // SSE arrival order differs from stage chronology because derived boundaries
  // are only known at the terminal frame; sort the reconstructed report before
  // applying the strict timeline validator.
  events.sort((left, right) => left.atMs - right.atMs);
  const timeline = createRequestTimeline(runId, events, finalState);
  const nativeStages = getStageDurations(timeline);
  stages = {
    ...stages,
    captureMs: nativeStages.captureMs,
    asrMs: nativeStages.asrMs,
    keywordNativeMs: nativeStages.keywordMs,
    renderMs: nativeStages.renderMs,
  };
  const allNames = ["capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end", "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end", "first_event", "first_token", "complete"];
  const present = new Set<string>(events.map((event) => event.name));
  return { runId, questionId: `q${index + 1}`, status: finalState, timeline, stages, nativeEvents, missingEvents: allNames.filter((name) => !present.has(name)), derivedEvents: events.filter((event) => !observed.has(event.name)).map((event) => event.name) };
}

async function main(): Promise<void> {
  const cases: TimelineCase[] = [];
  for (const [index, question] of questions.entries()) cases.push(await measure(question, index));
  const failures = cases.filter((item) => item.status === "failed");
  const manifest = { evaluator: "request-timeline-evaluator-v2", generatedAt: new Date().toISOString(), baseUrl, questionCount: questions.length, executionMode: "real_ask_sse", evidenceBoundary: "Native pipeline events are preferred when emitted by the route. Legacy SSE boundaries and stage durations remain marked as derived; capture/ASR/render stay null when this Ask-only runner has no browser audio/render context." };
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
