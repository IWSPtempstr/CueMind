import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDesktopEvent, type DesktopEvent, type TranscriptReadyEvent } from "@/lib/desktop-events";

interface ReplaySummary {
  inputPath: string;
  datasetType: "fixture_replay";
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
  const summary = summarize(inputPath, parsed.events, parsed.invalidLineCount, {
    provider: process.env.MODEL_PROVIDER,
    model: process.env.MODEL_NAME,
    baseUrl: process.env.MODEL_BASE_URL,
  });
  const manifest = {
    dataset: inputPath,
    datasetType: "fixture_replay",
    inputPath,
    generatedAt: new Date().toISOString(),
    evaluator: "scripts/validate-replay.ts",
    modelProvider: summary.modelProvider,
    modelName: summary.modelName,
    modelBaseUrl: summary.modelBaseUrl,
    evidenceBoundary: "Fixture event integrity and latency metadata only; no ASR, LLM, search, or card-quality claim.",
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
    else invalidLineCount += 1;
  }
  return { events, invalidLineCount };
}

function summarize(
  inputPath: string,
  events: DesktopEvent[],
  invalidLineCount: number,
  metadata: { provider?: string; model?: string; baseUrl?: string },
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
    datasetType: "fixture_replay",
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
  };
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
    "",
    "## Evidence Boundary",
    "",
    "This report validates JSONL event integrity and metadata supplied by the fixture. It does not prove real whisper.cpp transcription quality, local model structured output, live search quality, context-card correctness, or end-to-end latency.",
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
