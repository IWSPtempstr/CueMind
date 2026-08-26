import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDesktopEvent, type DesktopEvent, type TranscriptReadyEvent } from "@/lib/desktop-events";

interface ReplaySummary {
  inputPath: string;
  datasetType: "fixture_replay" | "trace_bearing_replay";
  eventCount: number;
  transcriptEventCount: number;
  invalidLineCount: number;
  duplicateEventIdCount: number;
  invalidTimingCount: number;
  emptyTranscriptCount: number;
  coveredDurationMs: number;
  asrLatencyMs: PercentileSummary | null;
  modelProvider: "llama.cpp" | "remote-api" | null;
  modelName: string | null;
  modelBaseUrl: string | null;
  providerFailureCount: number;
  invalidJsonCount: number;
  schemaInvalidCount: number;
  fallbackCount: number;
  providerStructuredOutputEventCount: number;
  searchEventCount: number;
  searchFallbackCount: number;
  cardGeneratedCount: number;
  cardFailureCount: number;
  cardLatencyMs: PercentileSummary | null;
}

interface PercentileSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

async function main(): Promise<void> {
  const inputPath = resolve(process.argv[2] ?? "fixtures/demo-meeting/sample-events.jsonl");
  const outputDir = resolve(process.argv[3] ?? "reports/replay");
  const raw = await readFile(inputPath, "utf8");
  const parsed = parseLines(raw);
  const workflowEvidence = extractWorkflowEvidence(raw);
  const summary = summarize(inputPath, parsed.events, parsed.invalidLineCount, {
    provider: process.env.MODEL_PROVIDER,
    model: process.env.MODEL_NAME,
    baseUrl: process.env.MODEL_BASE_URL,
  }, workflowEvidence);
  const manifest = {
    dataset: inputPath,
    datasetType: summary.datasetType,
    inputPath,
    generatedAt: new Date().toISOString(),
    evaluator: "scripts/validate-replay.ts",
    modelProvider: summary.modelProvider,
    modelName: summary.modelName,
    modelBaseUrl: summary.modelBaseUrl,
    evidenceBoundary: summary.datasetType === "trace_bearing_replay"
      ? "Trace-bearing replay envelope integrity plus recorded provider/search/card trace counters. This does not by itself prove production quality or unbounded replay coverage."
      : "Fixture event integrity and latency metadata only; no ASR, LLM, search, or card-quality claim.",
  };
  const scorecard = {
    status: summary.invalidLineCount === 0 && summary.duplicateEventIdCount === 0 && summary.invalidTimingCount === 0 && summary.emptyTranscriptCount === 0
      ? "pass"
      : "fail",
    denominator: summary.eventCount,
    checks: {
      jsonLinesValid: summary.invalidLineCount === 0,
      eventIdsUnique: summary.duplicateEventIdCount === 0,
      transcriptTimingValid: summary.invalidTimingCount === 0,
      transcriptTextNonEmpty: summary.emptyTranscriptCount === 0,
    },
    metrics: summary,
    providerFailureCount: summary.providerFailureCount,
    invalidJsonCount: summary.invalidJsonCount,
    schemaInvalidCount: summary.schemaInvalidCount,
    fallbackCount: summary.fallbackCount,
    providerStructuredOutputEventCount: summary.providerStructuredOutputEventCount,
    searchEventCount: summary.searchEventCount,
    searchFallbackCount: summary.searchFallbackCount,
    cardGeneratedCount: summary.cardGeneratedCount,
    cardFailureCount: summary.cardFailureCount,
    cardLatencyMs: summary.cardLatencyMs,
    blockedExternalEvidence: ["real_whisper_cpp", "local_llm", "live_search", "context_card_quality"],
  };
  const report = renderReport(manifest, scorecard);

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(resolve(outputDir, "report.md"), report),
  ]);
  console.log(`Replay report written to ${outputDir}`);
  console.log(report);
}

function parseLines(raw: string): { events: DesktopEvent[]; invalidLineCount: number } {
  const events: DesktopEvent[] = [];
  let invalidLineCount = 0;
  for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const event = parseDesktopEvent(line);
    if (event) events.push(event);
    else if (!isTraceBearingReplayLine(line)) invalidLineCount += 1;
  }
  return { events, invalidLineCount };
}

function isTraceBearingReplayLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || !isRecord(value.replayWindow) || !isRecord(value.trace)) return false;
    const window = value.replayWindow;
    return typeof window.id === "string" && typeof window.startMs === "number" &&
      typeof window.endMs === "number" && window.endMs > window.startMs &&
      Array.isArray(window.transcriptChunkIds) && window.transcriptChunkIds.every((id) => typeof id === "string");
  } catch {
    return false;
  }
}

function summarize(
  inputPath: string,
  events: DesktopEvent[],
  invalidLineCount: number,
  metadata: { provider?: string; model?: string; baseUrl?: string },
  workflowEvidence: WorkflowEvidence,
): ReplaySummary {
  const ids = new Set<string>();
  let duplicateEventIdCount = 0;
  for (const event of events) {
    const id = event.type === "transcript_ready" || event.type === "audio_chunk_ready" ? event.id : `${event.type}:${event.occurredAt}`;
    if (ids.has(id)) duplicateEventIdCount += 1;
    ids.add(id);
  }
  const transcripts = events.filter((event): event is TranscriptReadyEvent => event.type === "transcript_ready");
  const invalidTimingCount = transcripts.filter((event) => event.endMs <= event.startMs || event.startMs < 0).length;
  const emptyTranscriptCount = transcripts.filter((event) => event.text.trim().length === 0).length;
  const starts = transcripts.map((event) => event.startMs);
  const ends = transcripts.map((event) => event.endMs);
  const latencies = transcripts.flatMap((event) => typeof event.latencyMs === "number" ? [event.latencyMs] : []);
  const runtimeErrors = events.filter((event) => event.type === "runtime_error");
  const modelProvider = metadata.provider === "llama.cpp" || metadata.provider === "remote-api"
    ? metadata.provider
    : null;
  const modelBaseUrl = metadata.baseUrl
    ? redactBaseUrl(metadata.baseUrl, modelProvider === "remote-api")
    : null;
  const providerFailureCount = runtimeErrors.filter((event) =>
    event.code.startsWith("model_") || event.code.includes("provider"),
  ).length;
  const invalidJsonCount = runtimeErrors.filter((event) => event.code === "model_invalid_json").length;
  const schemaInvalidCount = runtimeErrors.filter((event) => event.code === "model_schema_invalid").length;
  const fallbackCount = runtimeErrors.filter((event) =>
    event.code === "provider_fallback" || event.message.toLowerCase().includes("fallback"),
  ).length;
  return {
    inputPath,
    datasetType: workflowEvidence.replayRecordCount > 0 ? "trace_bearing_replay" : "fixture_replay",
    eventCount: events.length,
    transcriptEventCount: transcripts.length,
    invalidLineCount,
    duplicateEventIdCount,
    invalidTimingCount,
    emptyTranscriptCount,
    coveredDurationMs: starts.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0,
    asrLatencyMs: latencies.length > 0 ? summarizePercentiles(latencies) : null,
    modelProvider,
    modelName: metadata.model?.trim() || null,
    modelBaseUrl,
    providerFailureCount,
    invalidJsonCount,
    schemaInvalidCount,
    fallbackCount,
    providerStructuredOutputEventCount: workflowEvidence.providerStructuredOutputEventCount,
    searchEventCount: workflowEvidence.searchEventCount,
    searchFallbackCount: workflowEvidence.searchFallbackCount,
    cardGeneratedCount: workflowEvidence.cardGeneratedCount,
    cardFailureCount: workflowEvidence.cardFailureCount,
    cardLatencyMs: workflowEvidence.cardLatencyMs,
  };
}

interface WorkflowEvidence {
  replayRecordCount: number;
  providerStructuredOutputEventCount: number;
  searchEventCount: number;
  searchFallbackCount: number;
  cardGeneratedCount: number;
  cardFailureCount: number;
  cardLatencyMs: PercentileSummary | null;
}

function extractWorkflowEvidence(raw: string): WorkflowEvidence {
  let replayRecordCount = 0;
  let providerStructuredOutputEventCount = 0;
  let searchEventCount = 0;
  let searchFallbackCount = 0;
  let cardGeneratedCount = 0;
  let cardFailureCount = 0;
  const cardLatencies: number[] = [];
  for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { continue; }
    if (!isRecord(value)) continue;
    if (isRecord(value.replayWindow) && isRecord(value.trace)) replayRecordCount += 1;
    const trace = isRecord(value.trace) ? value.trace : value;
    if (typeof trace.modelProvider === "string") providerStructuredOutputEventCount += 1;
    if (Array.isArray(trace.events)) {
      for (const event of trace.events) {
        if (!isRecord(event)) continue;
        if (event.tool === "search_web") {
          searchEventCount += 1;
          if (event.fallbackUsed === true) searchFallbackCount += 1;
        }
      }
    }
    if (trace.finalState === "card_generated") cardGeneratedCount += 1;
    if (trace.finalState === "model_failed" || trace.finalState === "search_failed") cardFailureCount += 1;
    const card = isRecord(value.card) ? value.card : null;
    const latency = card && isRecord(card.latencyMs) ? card.latencyMs.total : null;
    if (typeof latency === "number" && Number.isFinite(latency)) cardLatencies.push(latency);
  }
  return {
    replayRecordCount,
    providerStructuredOutputEventCount,
    searchEventCount,
    searchFallbackCount,
    cardGeneratedCount,
    cardFailureCount,
    cardLatencyMs: cardLatencies.length > 0 ? summarizePercentiles(cardLatencies) : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactBaseUrl(baseUrl: string, hostOnly: boolean): string {
  if (!hostOnly) return baseUrl;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "redacted-invalid-url";
  }
}

function summarizePercentiles(values: number[]): PercentileSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function renderReport(manifest: Record<string, unknown>, scorecard: Record<string, unknown>): string {
  const metrics = scorecard.metrics as ReplaySummary;
  const latency = metrics.asrLatencyMs;
  return [
    "# CueMind Replay Report",
    "",
    `- Dataset type: \`${manifest.datasetType}\``,
    `- Input: \`${metrics.inputPath}\``,
    `- Event count: ${metrics.eventCount}`,
    `- Transcript events: ${metrics.transcriptEventCount}`,
    `- Covered duration: ${metrics.coveredDurationMs} ms`,
    `- ASR latency: ${latency ? `count=${latency.count}, p50=${latency.p50} ms, p95=${latency.p95} ms` : "null (no latency metadata)"}`,
    `- Model provider: ${metrics.modelProvider ?? "unknown"}`,
    `- Model: ${metrics.modelName ?? "unknown"}`,
    `- Model base URL: ${metrics.modelBaseUrl ?? "unknown"}`,
    `- Provider failures: ${metrics.providerFailureCount}`,
    `- Invalid JSON: ${metrics.invalidJsonCount}`,
    `- Schema-invalid outputs: ${metrics.schemaInvalidCount}`,
    `- Fallbacks: ${metrics.fallbackCount}`,
    `- Provider structured-output events: ${metrics.providerStructuredOutputEventCount}`,
    `- Search events: ${metrics.searchEventCount}`,
    `- Search fallbacks: ${metrics.searchFallbackCount}`,
    `- Cards generated: ${metrics.cardGeneratedCount}`,
    `- Card failures: ${metrics.cardFailureCount}`,
    `- Card latency: ${metrics.cardLatencyMs ? `count=${metrics.cardLatencyMs.count}, p50=${metrics.cardLatencyMs.p50} ms, p95=${metrics.cardLatencyMs.p95} ms` : "null (no card events)"}`,
    "",
    "## Evidence Boundary",
    "",
    metrics.datasetType === "trace_bearing_replay"
      ? "This report validates trace-bearing replay envelope integrity and records observed provider/search/card trace metrics. It does not prove production quality, ASR accuracy, or coverage beyond the replay windows exercised."
      : "This report validates JSONL event integrity and metadata supplied by the fixture. It does not prove real whisper.cpp transcription quality, local model structured output, live search quality, context-card correctness, or end-to-end latency.",
    "",
    "## Checks",
    "",
    `- Status: \`${scorecard.status}\``,
    `- Invalid JSON/event lines: ${metrics.invalidLineCount}`,
    `- Duplicate event IDs: ${metrics.duplicateEventIdCount}`,
    `- Invalid transcript timing: ${metrics.invalidTimingCount}`,
    `- Empty transcript text: ${metrics.emptyTranscriptCount}`,
    "",
  ].join("\n");
}

void main();
