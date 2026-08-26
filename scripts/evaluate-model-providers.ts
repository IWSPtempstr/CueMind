import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { generateLlamaCppJson } from "@/lib/llama-cpp";
import { generateRemoteApiJson } from "@/lib/remote-api";
import {
  ModelProviderError,
  serializeModelProviderError,
  type ModelProviderName,
} from "@/lib/model-provider";

const WINDOW_MS = 60_000;
const MAX_INPUT_CHARS = 12_000;
const DEFAULT_RUNS = 3;
const DEFAULT_TRANSCRIPT = "/tmp/cuemind-runtime/cuemind-10min-asr.json";
const DEFAULT_OUTPUT_DIR = "reports/provider-evaluation";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8082";
const DEFAULT_LOCAL_MODEL = "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
const DEFAULT_LLAMA_SERVER = "/home/work/llama.cpp/build/bin/llama-server";
const TIMEOUT_MS = 120_000;

interface TranscriptWindow {
  text: string;
  segmentCount: number;
  startMs: number;
  endMs: number;
}

interface RunResult {
  run: number;
  provider: ModelProviderName;
  model: string;
  baseUrl: string;
  status: "pass" | "failed";
  latencyMs: number;
  output: { keyword: string } | null;
  error: Record<string, unknown> | null;
  excluded: boolean;
  exclusionReason?: string;
}

interface ProviderEvaluation {
  provider: ModelProviderName;
  model: string;
  baseUrl: string;
  status: "complete" | "blocked_external_dependency" | "failed";
  requestedRuns: number;
  completedRuns: number;
  validJsonCount: number;
  schemaValidCount: number;
  excludedRunCount: number;
  providerFailureCount: number;
  invalidJsonCount: number;
  schemaInvalidCount: number;
  keywordRepeatConsistency: number | null;
  latencyMs: PercentileSummary | null;
  errorCodes: Record<string, number>;
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
  const transcriptPath = process.env.EVAL_TRANSCRIPT_PATH ?? DEFAULT_TRANSCRIPT;
  const outputDir = process.env.EVAL_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
  const requestedRuns = parseRunCount(process.env.EVAL_RUNS);
  const window = await readTranscriptWindow(transcriptPath);
  const startedAt = new Date().toISOString();
  const local = await evaluateProvider({
    provider: "llama.cpp",
    baseUrl: process.env.LLAMA_CPP_BASE_URL ?? DEFAULT_LOCAL_BASE_URL,
    model: process.env.LLAMA_CPP_MODEL ?? DEFAULT_LOCAL_MODEL,
    apiKey: process.env.LLAMA_CPP_API_KEY ?? "",
    requestedRuns,
    window,
  });

  const remoteConfig = {
    baseUrl: process.env.REMOTE_API_BASE_URL?.trim() ?? "",
    model: process.env.REMOTE_API_MODEL?.trim() ?? "",
    apiKey: process.env.REMOTE_API_KEY?.trim() ?? "",
  };
  const remote = remoteConfig.baseUrl && remoteConfig.model && remoteConfig.apiKey
    ? await evaluateProvider({ provider: "remote-api", ...remoteConfig, requestedRuns, window })
    : blockedEvaluation(requestedRuns, remoteConfig);

  const allRuns = [...local.runs, ...remote.runs];
  const manifest = {
    runId: `provider-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    status: local.evaluation.status === "complete" ? "complete" : "partial",
    datasetType: "fixed_asr_window",
    transcriptPath,
    inputWindowMs: [window.startMs, window.endMs],
    inputSegments: window.segmentCount,
    inputChars: window.text.length,
    requestedRuns,
    providers: [local.evaluation, remote.evaluation],
    promptVersion: "context-card-prompt-v1-keyword-only",
    runtime: "llama.cpp OpenAI-compatible chat completions",
    llamaServerVersion: await readLlamaServerVersion(),
    modelSha256: await sha256IfReadable(local.evaluation.model),
    hardware: await readHardware(),
    startedAt,
    completedAt: new Date().toISOString(),
    evidenceBoundary: "Repeated provider structured-output and latency evidence for one fixed transcript window only; no search or card-quality claim.",
  };
  const scorecard = {
    status: local.evaluation.status === "complete" ? "complete" : "partial",
    denominator: {
      requestedRuns,
      localCompletedRuns: local.evaluation.completedRuns,
      remoteCompletedRuns: remote.evaluation.completedRuns,
      excludedRuns: local.evaluation.excludedRunCount + remote.evaluation.excludedRunCount,
    },
    providers: [local.evaluation, remote.evaluation],
    evidenceBoundary: manifest.evidenceBoundary,
  };

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(`${outputDir}/manifest.json`, manifest),
    writeJson(`${outputDir}/scorecard.json`, scorecard),
    writeJsonl(`${outputDir}/outputs.jsonl`, allRuns.filter((run) => run.output !== null)),
    writeJsonl(`${outputDir}/errors.jsonl`, allRuns.filter((run) => run.error !== null)),
    writeJsonl(`${outputDir}/latency.jsonl`, allRuns.map((run) => ({
      run: run.run,
      provider: run.provider,
      model: run.model,
      baseUrl: redactBaseUrl(run.baseUrl, run.provider === "remote-api"),
      latencyMs: run.latencyMs,
      status: run.status,
      excluded: run.excluded,
    }))),
    writeFile(`${outputDir}/report.md`, renderReport(manifest, scorecard), "utf8"),
  ]);

  console.log(`Provider evaluation report written to ${outputDir}`);
  console.log(renderReport(manifest, scorecard));
  if (local.evaluation.status !== "complete") process.exitCode = 1;
}

async function evaluateProvider(args: {
  provider: ModelProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
  requestedRuns: number;
  window: TranscriptWindow;
}): Promise<{ evaluation: ProviderEvaluation; runs: RunResult[] }> {
  const runs: RunResult[] = [];
  for (let run = 1; run <= args.requestedRuns; run += 1) {
    const started = Date.now();
    try {
      const result = args.provider === "remote-api"
        ? await generateRemoteApiJson<unknown>({
            baseUrl: args.baseUrl,
            model: args.model,
            apiKey: args.apiKey,
            system: keywordSystemPrompt(),
            prompt: keywordPrompt(args.window.text),
            timeoutMs: TIMEOUT_MS,
          })
        : await generateLlamaCppJson<unknown>({
            baseUrl: args.baseUrl,
            model: args.model,
            apiKey: args.apiKey,
            system: keywordSystemPrompt(),
            prompt: keywordPrompt(args.window.text),
            timeoutMs: TIMEOUT_MS,
          });
      const latencyMs = Date.now() - started;
      const keyword = isRecord(result) && typeof result.keyword === "string" ? result.keyword.trim() : "";
      runs.push({
        run,
        provider: args.provider,
        model: args.model,
        baseUrl: args.baseUrl,
        status: keyword ? "pass" : "failed",
        latencyMs,
        output: keyword ? { keyword } : null,
        error: keyword ? null : { code: "model_schema_invalid", message: "keyword field missing or empty" },
        excluded: !keyword,
        ...(keyword ? {} : { exclusionReason: "schema_invalid" }),
      });
    } catch (caught) {
      const error = serializeError(caught);
      runs.push({
        run,
        provider: args.provider,
        model: args.model,
        baseUrl: args.baseUrl,
        status: "failed",
        latencyMs: Date.now() - started,
        output: null,
        error,
        excluded: true,
        exclusionReason: String(error.code ?? "provider_failure"),
      });
    }
  }
  return { evaluation: summarizeProvider(args, runs), runs };
}

function blockedEvaluation(
  requestedRuns: number,
  config: { baseUrl: string; model: string; apiKey: string },
): { evaluation: ProviderEvaluation; runs: RunResult[] } {
  return {
    runs: [],
    evaluation: {
      provider: "remote-api",
      model: config.model || "unknown",
      baseUrl: config.baseUrl || "unknown",
      status: "blocked_external_dependency",
      requestedRuns,
      completedRuns: 0,
      validJsonCount: 0,
      schemaValidCount: 0,
      excludedRunCount: 0,
      providerFailureCount: 0,
      invalidJsonCount: 0,
      schemaInvalidCount: 0,
      keywordRepeatConsistency: null,
      latencyMs: null,
      errorCodes: {},
    },
  };
}

function summarizeProvider(
  args: { provider: ModelProviderName; baseUrl: string; model: string; requestedRuns: number },
  runs: RunResult[],
): ProviderEvaluation {
  const successful = runs.filter((run) => run.status === "pass");
  const keywords = successful.flatMap((run) => run.output ? [run.output.keyword] : []);
  const errorCodes: Record<string, number> = {};
  for (const run of runs) {
    if (run.error) {
      const code = String(run.error.code ?? "unexpected");
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
    }
  }
  const counts = new Map<string, number>();
  for (const keyword of keywords) counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
  const mostCommon = Math.max(0, ...counts.values());
  return {
    provider: args.provider,
    model: args.model,
    baseUrl: redactBaseUrl(args.baseUrl, args.provider === "remote-api"),
    status: successful.length === args.requestedRuns ? "complete" : "failed",
    requestedRuns: args.requestedRuns,
    completedRuns: successful.length,
    validJsonCount: runs.filter((run) => run.output !== null || run.error?.code === "model_schema_invalid").length,
    schemaValidCount: successful.length,
    excludedRunCount: runs.filter((run) => run.excluded).length,
    providerFailureCount: runs.filter((run) => run.error !== null).length,
    invalidJsonCount: runs.filter((run) => run.error?.code === "model_invalid_json").length,
    schemaInvalidCount: runs.filter((run) => run.error?.code === "model_schema_invalid").length,
    keywordRepeatConsistency: keywords.length > 0 ? mostCommon / keywords.length : null,
    latencyMs: successful.length > 0 ? summarizePercentiles(successful.map((run) => run.latencyMs)) : null,
    errorCodes,
  };
}

function keywordSystemPrompt(): string {
  return "从技术会议转写中识别一个此刻最值得补充背景的具体技术关键词。只返回 JSON：{\"keyword\":\"...\"}。不要返回泛化词。";
}

function keywordPrompt(text: string): string {
  return `固定评估窗口（不包含评答案）：\n${text}`;
}

async function readTranscriptWindow(path: string): Promise<TranscriptWindow> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.transcription)) {
    throw new Error("Transcript JSON has no transcription array");
  }
  const parts: string[] = [];
  let startMs = 0;
  let endMs = 0;
  for (const item of parsed.transcription) {
    if (!isRecord(item)) continue;
    const offsets = item.offsets;
    if (!isRecord(offsets) || typeof offsets.from !== "number" || typeof offsets.to !== "number") continue;
    if (offsets.from >= WINDOW_MS) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    if (parts.length === 0) startMs = offsets.from;
    endMs = offsets.to;
    parts.push(text);
  }
  const text = parts.join("\n").slice(0, MAX_INPUT_CHARS);
  if (!text) throw new Error("No transcript text in the first 60s window");
  return { text, segmentCount: parts.length, startMs, endMs };
}

function parseRunCount(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_RUNS);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 20 ? parsed : DEFAULT_RUNS;
}

function serializeError(value: unknown): Record<string, unknown> {
  if (value instanceof ModelProviderError) return { ...serializeModelProviderError(value) };
  return { code: "unexpected", message: value instanceof Error ? value.message : String(value) };
}

function redactBaseUrl(baseUrl: string, hostOnly: boolean): string {
  if (!hostOnly) return baseUrl;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "redacted-invalid-url";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, values.map((value) => JSON.stringify(value)).concat(values.length ? [""] : []).join("\n"), "utf8");
}

async function sha256IfReadable(path: string): Promise<string | null> {
  try {
    const result = await execFileAsync("sha256sum", [path]);
    return result.stdout.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

async function readLlamaServerVersion(): Promise<string | null> {
  try {
    const result = await execFileAsync(process.env.LLAMA_SERVER_BIN ?? DEFAULT_LLAMA_SERVER, ["--version"]);
    return `${result.stdout} ${result.stderr}`.trim().replace(/\s+/g, " ") || null;
  } catch {
    return null;
  }
}

async function readHardware(): Promise<string | null> {
  try {
    const result = await execFileAsync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function renderReport(manifest: Record<string, unknown>, scorecard: Record<string, unknown>): string {
  const providers = scorecard.providers as ProviderEvaluation[];
  const lines = [
    "# CueMind Model Provider Evaluation",
    "",
    `- Status: \`${scorecard.status}\``,
    `- Dataset: \`${manifest.datasetType}\` (${manifest.inputWindowMs})`,
    `- Input segments/chars: ${manifest.inputSegments}/${manifest.inputChars}`,
    `- Requested runs per provider: ${manifest.requestedRuns}`,
    `- llama.cpp version: ${manifest.llamaServerVersion ?? "unavailable"}`,
    `- Hardware: ${manifest.hardware ?? "unavailable"}`,
    "",
    "## Provider Results",
    "",
  ];
  for (const provider of providers) {
    lines.push(
      `### ${provider.provider}`,
      `- Status: \`${provider.status}\``,
      `- Model/base URL: \`${provider.model}\` / \`${provider.baseUrl}\``,
      `- Denominator: requested=${provider.requestedRuns}, completed=${provider.completedRuns}, excluded=${provider.excludedRunCount}`,
      `- Valid JSON: ${provider.validJsonCount}/${provider.requestedRuns}`,
      `- Schema valid: ${provider.schemaValidCount}/${provider.requestedRuns}`,
      `- Keyword repeat consistency: ${provider.keywordRepeatConsistency ?? "null"}`,
      `- Latency: ${provider.latencyMs ? `P50=${provider.latencyMs.p50} ms, P95=${provider.latencyMs.p95} ms` : "null"}`,
      `- Errors: ${JSON.stringify(provider.errorCodes)}`,
      "",
    );
  }
  lines.push(
    "## Evidence Boundary",
    "",
    String(manifest.evidenceBoundary),
    "Remote evaluation is external-dependency blocked unless `REMOTE_API_BASE_URL`, `REMOTE_API_MODEL`, and `REMOTE_API_KEY` are all explicitly supplied.",
    "Replay integrity and provider structured-output evaluation do not establish live search quality, source grounding, card correctness, or production readiness.",
    "",
  );
  return lines.join("\n");
}

void main();
