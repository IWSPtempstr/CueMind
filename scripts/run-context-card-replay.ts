import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { POST } from "@/app/api/context-cards/route";
import { buildDemoCandidateWindows, type DemoCandidateWindow } from "@/lib/replay";

type ReplayTranscript = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
};

type ReplayResult = {
  candidateId: string;
  finalState: string;
  replayWindow: { startMs: number; endMs: number; transcriptChunkIds: string[]; closeReason: string };
  manifest: { version: string; mediaSha256: string; startMs: number; endMs: number; scenario: string; asrProvider: string; asrVersion: string; windowingVersion: string };
  requestMetadata: { mode: "live" | "mock"; endpoint: string; inputChars: number };
  card: unknown;
  failure: unknown;
  trace: Record<string, unknown>;
  stageLatencyMs: { keyword?: number; search?: number; generation?: number; total?: number };
};

const DEFAULT_INPUT = "fixtures/demo-meeting/sample-events.jsonl";
const DEFAULT_MANIFEST = "fixtures/demo-meeting/demo-manifest.json";
const DEFAULT_OUTPUT = "/tmp/cuemind-runtime/cuemind-10min-context-card-replay.jsonl";
const DEFAULT_ENDPOINT = "http://127.0.0.1:3000/api/context-cards";

async function main(): Promise<void> {
  loadDotEnv(resolve(".env"));
  const mode = process.env.REPLAY_MODE === "mock" ? "mock" : "live";
  const inputPath = resolve(process.env.REPLAY_INPUT ?? DEFAULT_INPUT);
  const manifestPath = resolve(process.env.REPLAY_MANIFEST ?? DEFAULT_MANIFEST);
  const outputPath = resolve(process.env.REPLAY_OUTPUT ?? DEFAULT_OUTPUT);
  const endpoint = process.env.CONTEXT_CARD_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  const maxWindows = boundedInteger(process.env.REPLAY_MAX_WINDOWS, Number.POSITIVE_INFINITY, 1, 1_000);
  const manifest = await readManifest(manifestPath);
  const transcripts = await readTranscripts(inputPath);
  const windows = buildCandidateWindows(transcripts, manifest).slice(0, maxWindows);
  if (windows.length === 0) throw new Error("Replay contains no transcript windows");

  const settings = buildSettings();
  const knownKeywords: string[] = [];
  const results: ReplayResult[] = [];
  const restoreFetch = mode === "mock" ? installMockFetch() : undefined;
  try {
    for (const window of windows) {
      const candidateId = stableCandidateId(window);
      const body = {
        candidateId,
        datasetVersion: manifest.version,
        windowingVersion: manifest.windowingVersion,
        coreStartMs: window.coreStartMs,
        coreEndMs: window.coreEndMs,
        contextStartMs: window.contextStartMs,
        contextEndMs: window.contextEndMs,
        recentTranscript: transcripts.filter((item) => item.startMs < window.contextEndMs && item.endMs > window.contextStartMs).map((item) => item.text).join(" ").slice(-12_000),
        knownKeywords,
        transcriptChunkIds: window.transcriptChunkIds,
        settings,
      };
      const started = performance.now();
      const response = mode === "mock"
        ? await POST(new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        : await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as Record<string, unknown>;
      const trace = sanitizeTerminalTrace(payload.trace, candidateId);
      const card = isRecord(payload.card) ? payload.card : null;
      const failure = isRecord(payload.failure) ? payload.failure : null;
      const keyword = card && typeof card.keyword === "string" ? card.keyword.trim() : extractKeyword(trace);
      if (keyword && !knownKeywords.includes(keyword)) knownKeywords.push(keyword);
      const stageLatencyMs = extractStageLatency(trace, card, Math.round(performance.now() - started));
      results.push({
        candidateId,
        finalState: typeof trace.finalState === "string" ? trace.finalState : "invalid_schema",
        replayWindow: {
          startMs: window.coreStartMs,
          endMs: window.coreEndMs,
          transcriptChunkIds: window.transcriptChunkIds,
          closeReason: window.windowCloseReason,
        },
        manifest: publicManifest(manifest),
        requestMetadata: { mode, endpoint: mode === "live" ? redactEndpoint(endpoint) : "in-process-route", inputChars: body.recentTranscript.length },
        card,
        failure,
        trace,
        stageLatencyMs,
      });
    }
  } finally {
    restoreFetch?.();
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, results.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  console.log(JSON.stringify({ mode, inputPath, manifestPath, outputPath, windowCount: results.length, cardCount: results.filter((item) => item.card !== null).length }, null, 2));
}

interface DemoManifest {
  version: string;
  mediaPath: string;
  mediaSha256: string;
  startMs: number;
  endMs: number;
  scenario: string;
  asrProvider: string;
  asrVersion: string;
  windowingVersion: string;
  windowing: { targetCoreMinMs: number; maxCoreMs: number; contextOverlapMs: number };
}

async function readManifest(path: string): Promise<DemoManifest> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const windowing = isRecord(value.windowing) ? value.windowing : {};
  if (!isNonEmptyString(value.version) || !isNonEmptyString(value.mediaPath) || !isNonEmptyString(value.mediaSha256) ||
    !isNonEmptyString(value.scenario) || !isNonEmptyString(value.asrProvider) || !isNonEmptyString(value.asrVersion) || !isNonEmptyString(value.windowingVersion) ||
    !isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs) || value.endMs <= value.startMs ||
    !isFiniteNumber(windowing.targetCoreMinMs) || !isFiniteNumber(windowing.maxCoreMs) || !isFiniteNumber(windowing.contextOverlapMs)) {
    throw new Error(`Invalid demo manifest: ${path}`);
  }
  return { version: value.version, mediaPath: value.mediaPath, mediaSha256: value.mediaSha256, startMs: value.startMs, endMs: value.endMs, scenario: value.scenario, asrProvider: value.asrProvider, asrVersion: value.asrVersion, windowingVersion: value.windowingVersion, windowing: { targetCoreMinMs: windowing.targetCoreMinMs, maxCoreMs: windowing.maxCoreMs, contextOverlapMs: windowing.contextOverlapMs } };
}

function buildCandidateWindows(transcripts: ReplayTranscript[], manifest: DemoManifest): DemoCandidateWindow[] {
  return buildDemoCandidateWindows(transcripts
    .filter((item) => item.startMs >= manifest.startMs && item.endMs <= manifest.endMs)
    .map((item) => ({ ...item, sentenceBoundary: /[.!?\u3002\uff01\uff1f]$/.test(item.text.trim()) })), {
    datasetVersion: manifest.version,
    mediaId: manifest.mediaSha256,
    asrVersion: manifest.asrVersion,
    windowingVersion: manifest.windowingVersion,
    minimumDurationMs: manifest.windowing.targetCoreMinMs,
    contextOverlapMs: manifest.windowing.contextOverlapMs,
    maximumDurationMs: manifest.windowing.maxCoreMs,
  });
}

function stableCandidateId(window: DemoCandidateWindow): string {
  return createHash("sha256").update(JSON.stringify(window.candidateIdInputs)).digest("hex");
}

function publicManifest(manifest: DemoManifest): ReplayResult["manifest"] {
  return { version: manifest.version, mediaSha256: manifest.mediaSha256, startMs: manifest.startMs, endMs: manifest.endMs, scenario: manifest.scenario, asrProvider: manifest.asrProvider, asrVersion: manifest.asrVersion, windowingVersion: manifest.windowingVersion };
}

function sanitizeTerminalTrace(value: unknown, candidateId: string): Record<string, unknown> {
  const trace = isRecord(value) ? value : {};
  return {
    traceId: typeof trace.traceId === "string" ? trace.traceId : "missing-trace-id",
    candidateId,
    finalState: typeof trace.finalState === "string" ? trace.finalState : "invalid_schema",
    decisionSource: typeof trace.decisionSource === "string" ? trace.decisionSource : "system",
    duplicateOfCandidateId: typeof trace.duplicateOfCandidateId === "string" ? trace.duplicateOfCandidateId : undefined,
    totalLatencyMs: typeof trace.totalLatencyMs === "number" ? trace.totalLatencyMs : undefined,
  };
}

function buildSettings() {
  return {
    modelProvider: "llama.cpp" as const,
    llamaCppBaseUrl: process.env.LLAMA_CPP_BASE_URL?.trim() || "http://127.0.0.1:8082",
    llamaCppModel: process.env.LLAMA_CPP_MODEL?.trim() || "Qwen3-4B",
    llamaCppApiKey: process.env.LLAMA_CPP_API_KEY?.trim() || "",
    remoteApiBaseUrl: process.env.REMOTE_API_BASE_URL?.trim() || "",
    remoteApiModel: process.env.REMOTE_API_MODEL?.trim() || "",
    remoteApiApiKey: process.env.REMOTE_API_KEY?.trim() || "",
    searchProvider: "tavily" as const,
    searchApiKey: process.env.TAVILY_API_KEY?.trim() || "",
    enableAgentReachFallback: true,
  };
}

async function readTranscripts(path: string): Promise<ReplayTranscript[]> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type !== "transcript_ready" || typeof value.id !== "string" || typeof value.text !== "string" || typeof value.startMs !== "number" || typeof value.endMs !== "number") return [];
      return [{ id: value.id, text: value.text, startMs: value.startMs, endMs: value.endMs }];
    } catch { return []; }
  });
}

function installMockFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url.includes("/chat/completions")) {
      const prompt = JSON.stringify(body.messages ?? []);
      const content = prompt.includes("<search_evidence_untrusted>")
        ? { keyword: "Agent Harness", explanation: "Agent Harness 是用于约束 Agent 执行流程、工具和交付质量的一组工程化机制。", whyNow: "会议正在讨论 Harness 如何决定 Agent 上线和执行边界。" }
        : { keyword: "Agent Harness" };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.tavily.com/search")) {
      return new Response(JSON.stringify({ results: [
        { title: "Agent Harness overview", url: "https://example.com/agent-harness", content: "Agent Harness provides engineering controls for agent execution and evaluation." },
        { title: "Agent evaluation guide", url: "https://example.com/agent-evaluation", content: "Agent evaluation uses traces, tool boundaries, and reproducible replay." },
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return original(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function extractKeyword(trace: Record<string, unknown> | null): string | null {
  return trace?.finalState === "card_shown" || trace?.finalState === "card_generated" ? "Agent Harness" : null;
}

function extractStageLatency(trace: Record<string, unknown> | null, card: Record<string, unknown> | null, fallbackTotal: number) {
  const result: { keyword?: number; search?: number; generation?: number; total?: number } = { total: fallbackTotal };
  const events = trace && Array.isArray(trace.events) ? trace.events.filter(isRecord) : [];
  const model = events.find((event) => event.type === "model_decision");
  const tool = events.find((event) => event.type === "tool_result");
  const generation = events.find((event) => event.type === "card_generation");
  if (typeof model?.durationMs === "number") result.keyword = model.durationMs;
  if (typeof tool?.durationMs === "number") result.search = tool.durationMs;
  if (typeof generation?.durationMs === "number") result.generation = generation.durationMs;
  if (typeof trace?.totalLatencyMs === "number") result.total = trace.totalLatencyMs;
  if (card && isRecord(card.latencyMs)) {
    const total = card.latencyMs.total;
    if (typeof total === "number") result.total = total;
  }
  return result;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function redactEndpoint(value: string): string {
  try { return new URL(value).origin + new URL(value).pathname; } catch { return "invalid-endpoint"; }
}

function loadDotEnv(path: string): void {
  try {
    const source = readFileSync(path, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch { /* .env is optional for mock mode and explicit shell environments. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
