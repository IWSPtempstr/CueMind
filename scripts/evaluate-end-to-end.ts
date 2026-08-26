import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_CONTEXT_REPORT = "reports/context-card-evaluation";
const DEFAULT_PROVIDER_REPORT = "reports/provider-evaluation";
const DEFAULT_MILVUS_REPORT = "reports/milvus-retrieval-evaluation";
const DEFAULT_REPLAY_REPORT = "reports/replay";
const DEFAULT_OUTPUT = "reports/end-to-end-evaluation";
type JsonObject = Record<string, unknown>;

interface CaseResult {
  searchPath?: string;
  actualDecision?: string;
  cardSuccess?: boolean;
  gracefulFailure?: boolean;
  latencyMs?: { search?: number; generation?: number; total?: number };
  failureCode?: string;
}

async function main(): Promise<void> {
  const outputDir = resolve(process.env.E2E_OUTPUT_DIR ?? DEFAULT_OUTPUT);
  const contextReportDir = resolve(process.env.CONTEXT_CARD_REPORT_DIR ?? DEFAULT_CONTEXT_REPORT);
  const providerReportDir = resolve(process.env.PROVIDER_REPORT_DIR ?? DEFAULT_PROVIDER_REPORT);
  const milvusReportDir = resolve(process.env.MILVUS_REPORT_DIR ?? DEFAULT_MILVUS_REPORT);
  const replayReportDir = resolve(process.env.REPLAY_REPORT_DIR ?? DEFAULT_REPLAY_REPORT);
  const contextManifest = await readJsonIfPresent(`${contextReportDir}/manifest.json`);
  const contextScorecard = await readJsonIfPresent(`${contextReportDir}/scorecard.json`);
  const contextCases = await readJsonl<CaseResult>(`${contextReportDir}/cases.jsonl`);
  const replayCases = await readTraceReplayCases();
  const cases = replayCases.length > 0 ? replayCases : contextCases;
  const providerScorecard = await readJsonIfPresent(`${providerReportDir}/scorecard.json`);
  const milvusScorecard = await readJsonIfPresent(`${milvusReportDir}/scorecard.json`);
  const replayScorecard = await readJsonIfPresent(`${replayReportDir}/scorecard.json`);
  const providerEntries = providerScorecard && Array.isArray(providerScorecard.providers)
    ? providerScorecard.providers.filter(isRecord)
    : [];
  const failures: Record<string, number> = {};
  for (const item of cases) if (item.failureCode) failures[item.failureCode] = (failures[item.failureCode] ?? 0) + 1;
  const contextIsLive = replayCases.length > 0 || contextManifest?.executionMode === "live";
  const milvusIsComplete = milvusScorecard?.status === "complete";
  const replayIsAvailable = replayScorecard !== null;
  const scorecard = {
    status: cases.length === 0 ? "blocked_external_dependency" : contextIsLive && milvusIsComplete && replayIsAvailable ? "complete" : "partial",
    releaseGate: contextIsLive && milvusIsComplete && replayIsAvailable ? "pass" : "blocked_external_dependency",
    denominator: {
      replayCases: cases.length,
      scoredCases: cases.filter((item) => item.cardSuccess || item.gracefulFailure).length,
      excludedCases: cases.filter((item) => item.cardSuccess === false && !item.gracefulFailure).length,
    },
    providerStructuredOutput: providerScorecard ? providerScorecard.status : "missing",
    searchEvidence: contextIsLive ? "fixed_snapshot_search_path_exercised" : "fixed_snapshot_only",
    cardGeneration: contextScorecard?.status ?? "missing",
    milvusEvidence: milvusScorecard?.status ?? "missing",
    replayEvidence: replayScorecard?.status ?? "missing",
    searchPathCounts: countBy(cases, (item) => item.searchPath ?? "unknown"),
    finalStateCounts: countBy(cases, (item) => item.actualDecision ?? "unknown"),
    failureCounts: failures,
    latency: {
      search: percentiles(cases.flatMap((item) => numberValue(item.latencyMs?.search))),
      generation: percentiles(cases.flatMap((item) => numberValue(item.latencyMs?.generation))),
      total: percentiles(cases.flatMap((item) => numberValue(item.latencyMs?.total))),
    },
    evidenceBoundary: "This release-gate summary combines the available evaluator artifacts. It does not convert synthetic fixed-source results, blocked Milvus status, or missing replay events into production readiness.",
  };
  const manifest = {
    evaluator: "end-to-end-evaluator-v1",
    generatedAt: new Date().toISOString(),
    inputs: { contextReportDir, providerReportDir, milvusReportDir, replayReportDir },
    localOnlyEvidence: providerEntries.find((item) => item.provider === "llama.cpp") ?? "missing",
    remoteProviderEvidence: providerEntries.find((item) => item.provider === "remote-api") ?? "missing",
    searchEvidence: { status: scorecard.searchEvidence, contextReport: contextReportDir },
    milvusEvidence: milvusScorecard ?? "missing",
    unverifiedProductionClaims: [
      "Windows dual-track audio capture",
      "long-video ASR stability",
      "live search quality and agent-reach availability",
      "Milvus ingestion completeness and embedding quality",
      "production card quality and release readiness",
    ],
    evidenceBoundary: scorecard.evidenceBoundary,
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(`${outputDir}/manifest.json`, manifest),
    writeJson(`${outputDir}/scorecard.json`, scorecard),
    writeJsonl(`${outputDir}/cases.jsonl`, cases),
    writeFile(`${outputDir}/report.md`, renderReport(manifest, scorecard), "utf8"),
  ]);
  console.log(`End-to-end evaluation report written to ${outputDir}`);
  console.log(renderReport(manifest, scorecard));
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function numberValue(value: unknown): number[] {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : [];
}

function percentiles(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return { count: sorted.length, min: sorted[0], max: sorted[sorted.length - 1], p50: at(0.5), p95: at(0.95) };
}

async function readJsonIfPresent(path: string): Promise<JsonObject | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as JsonObject; } catch { return null; }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch { return []; }
}

async function readTraceReplayCases(): Promise<CaseResult[]> {
  const replayPath = process.env.REPLAY_INPUT_JSONL;
  if (!replayPath) return [];
  try {
    const raw = await readFile(replayPath, "utf8");
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line): CaseResult[] => {
      try {
        const value = JSON.parse(line) as JsonObject;
        const trace = isRecord(value.trace) ? value.trace : null;
        if (!trace) return [];
        const events = Array.isArray(trace.events) ? trace.events.filter(isRecord) : [];
        const search = events.find((event) => event.type === "tool_result");
        const generation = events.find((event) => event.type === "card_generation");
        const card = isRecord(value.card) ? value.card : null;
        const terminal = typeof trace.finalState === "string" ? trace.finalState : "unknown";
        return [{
          searchPath: typeof search?.provider === "string" ? search.provider : terminal === "skipped" ? "none" : "failure",
          actualDecision: terminal,
          cardSuccess: terminal === "card_generated" && card !== null,
          gracefulFailure: terminal === "skipped" || terminal === "search_failed" || terminal === "model_failed",
          latencyMs: {
            search: typeof search?.durationMs === "number" ? search.durationMs : undefined,
            generation: typeof generation?.durationMs === "number" ? generation.durationMs : undefined,
            total: typeof trace.totalLatencyMs === "number" ? trace.totalLatencyMs : undefined,
          },
          failureCode: isRecord(value.failure) && typeof value.failure.reason === "string" ? value.failure.reason : undefined,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

function renderReport(manifest: JsonObject, scorecard: JsonObject): string {
  const denominator = scorecard.denominator as JsonObject;
  const searchPathCounts = scorecard.searchPathCounts as JsonObject;
  const finalStateCounts = scorecard.finalStateCounts as JsonObject;
  const failureCounts = scorecard.failureCounts as JsonObject;
  const unverifiedClaims = manifest.unverifiedProductionClaims as string[];
  return [
    "# CueMind End-to-End Evaluation Report",
    "",
    `- Status: \`${String(scorecard.status)}\``,
    `- Replay cases: ${String(denominator.replayCases)}; scored=${String(denominator.scoredCases)}; excluded=${String(denominator.excludedCases)}`,
    "",
    "## Evidence Layers",
    "",
    `- Local-only provider evidence: ${formatValue(manifest.localOnlyEvidence)}`,
    `- Remote provider evidence: ${formatValue(manifest.remoteProviderEvidence)}`,
    `- Search evidence: ${String(scorecard.searchEvidence)}`,
    `- Milvus evidence: ${formatValue(manifest.milvusEvidence)}`,
    `- Replay evidence: ${String(scorecard.replayEvidence)}`,
    "",
    "## Search Paths",
    "",
    ...Object.entries(searchPathCounts).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Final States",
    "",
    ...Object.entries(finalStateCounts).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Failures",
    "",
    ...Object.entries(failureCounts).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Unverified Production Claims",
    "",
    ...unverifiedClaims.map((value) => `- ${value}`),
    "",
    "## Evidence Boundary",
    "",
    String(scorecard.evidenceBoundary),
  ].join("\n") + "\n";
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
