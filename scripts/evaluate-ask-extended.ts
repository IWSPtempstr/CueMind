import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CacheMode = "cold" | "hot";

export interface AskEvaluationQuestion {
  id: string;
  question: string;
  cacheMode: CacheMode;
  recentTranscript?: string;
  termHint?: string;
  sourceVideo?: string;
  sourceTimeSec?: number;
  sourceRange?: string;
  topic?: string;
  tags?: string[];
}

export interface AskEvaluationManifest {
  version: string;
  authorized?: boolean;
  questions: AskEvaluationQuestion[];
  datasetVersion?: string;
  authorizationNote?: string;
}

export interface AskEvaluationResult {
  id: string;
  cacheMode: CacheMode;
  question: string;
  status: "answered" | "degraded" | "failed";
  completionMs: number;
  firstEventMs: number | null;
  firstByteMs: number | null;
  finalState: string;
  stages: { keywordMs: number; searchMs: number; generationMs: number } | null;
  observedCacheHit?: boolean;
  warmFinalState?: string;
  cacheEligible?: boolean;
  error: string | null;
  /** Captured content quality fields (empty when the turn produced no answer text). */
  answer: string;
  sources: { title: string; url: string; sourceType?: string }[];
  keywords: string[];
  searched?: boolean;
  persisted?: boolean;
}

interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

interface ModeSummary {
  denominator: { total: number; failed: number };
  completionMs: Percentiles | null;
  firstEventMs: Percentiles | null;
  firstByteMs: Percentiles | null;
  finalStates: Record<string, number>;
  cacheModeMismatches: number;
}

interface AskEvaluationSummary {
  denominator: { total: number; failed: number };
  completionMs: Percentiles | null;
  firstEventMs: Percentiles | null;
  firstByteMs: Percentiles | null;
  byCacheMode: Record<CacheMode, ModeSummary>;
}

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_OUTPUT_DIR = "reports/ask-extended-evaluation";
const TIMEOUT_MS = 60_000;
/** Unique per run so a bootstrap never collides with an existing session (401). */
const EVAL_SESSION_ID = `ask-extended-eval-${Date.now().toString(36)}`;

/** Bootstraps the eval session and returns its access token (null if denied). */
async function bootstrapEvalSession(baseUrl: string): Promise<string | null> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: EVAL_SESSION_ID,
      title: "Ask extended evaluation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transcriptChunks: [],
      suggestionBatches: [],
      chatMessages: [],
      meetingReport: null,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`session bootstrap HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = (await response.json()) as { sessionAccessToken?: unknown };
  return typeof payload.sessionAccessToken === "string" ? payload.sessionAccessToken : null;
}

export function parseAskEvaluationManifest(raw: string): AskEvaluationManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("manifest must be valid JSON");
  }
  if (!isRecord(value)) throw new Error("manifest must be a JSON object");
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new Error("manifest version is required");
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Error("manifest questions must be a non-empty array");
  }
  const ids = new Set<string>();
  const questions = value.questions.map((item, index): AskEvaluationQuestion => {
    if (!isRecord(item) || typeof item.question !== "string" || item.question.trim() === "") {
      throw new Error(`question[${index}] question is required`);
    }
    const id = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `question-${index + 1}`;
    if (ids.has(id)) throw new Error(`duplicate question id: ${id}`);
    ids.add(id);
    const cacheMode = item.cacheMode;
    if (cacheMode !== "cold" && cacheMode !== "hot") {
      throw new Error(`question[${index}] cacheMode must be cold or hot`);
    }
    return {
      id,
      question: item.question.trim(),
      cacheMode,
      recentTranscript: typeof item.recentTranscript === "string" ? item.recentTranscript : undefined,
      termHint: typeof item.termHint === "string" ? item.termHint : undefined,
      sourceVideo: typeof item.sourceVideo === "string" ? item.sourceVideo : undefined,
      sourceTimeSec: typeof item.sourceTimeSec === "number" ? item.sourceTimeSec : undefined,
      sourceRange: typeof item.sourceRange === "string" ? item.sourceRange : undefined,
      topic: typeof item.topic === "string" ? item.topic : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    };
  });
  return {
    version: value.version.trim(),
    authorized: value.authorized === true,
    questions,
    datasetVersion: typeof value.datasetVersion === "string" ? value.datasetVersion : undefined,
    authorizationNote: typeof value.authorizationNote === "string" ? value.authorizationNote : undefined,
  };
}

export function assertExtendedDatasetSize(manifest: AskEvaluationManifest): void {
  if (manifest.questions.length < 30) {
    throw new Error(`extended evaluation requires at least 30 questions; got ${manifest.questions.length}`);
  }
}

export function summarizeAskResults(results: AskEvaluationResult[]): AskEvaluationSummary {
  const byCacheMode = {
    cold: summarizeMode(results.filter((result) => result.cacheMode === "cold")),
    hot: summarizeMode(results.filter((result) => result.cacheMode === "hot")),
  } satisfies Record<CacheMode, ModeSummary>;
  return {
    denominator: { total: results.length, failed: results.filter((result) => result.status === "failed").length },
    completionMs: percentiles(results.map((result) => result.completionMs).filter(isFiniteNumber)),
    firstEventMs: percentiles(results.map((result) => result.firstEventMs).filter(isFiniteNumber)),
    firstByteMs: percentiles(results.map((result) => result.firstByteMs).filter(isFiniteNumber)),
    byCacheMode,
  };
}

async function measureOne(baseUrl: string, question: AskEvaluationQuestion, sessionToken: string | null): Promise<AskEvaluationResult> {
  const startedAt = performance.now();
  let firstEventMs: number | null = null;
  let firstByteMs: number | null = null;
  let completionMs = 0;
  let finalState = "no_done";
  let stages: AskEvaluationResult["stages"] = null;
  let observedCacheHit: boolean | undefined;
  let answerText = "";
  let sources: { title: string; url: string; sourceType?: string }[] = [];
  let keywords: string[] = [];
  let searched: boolean | undefined;
  try {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
      },
      body: JSON.stringify({
        sessionId: EVAL_SESSION_ID,
        question: question.question,
        cacheMode: question.cacheMode,
        cacheKey: question.termHint?.trim().toLowerCase() || question.id,
        recentTranscript: question.recentTranscript ?? "",
        termHint: question.termHint,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:") || trimmed.slice(5).trim() === "[DONE]") return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>; } catch { return; }
      if (firstEventMs === null) firstEventMs = performance.now() - startedAt;
      const event = typeof data.event === "string" ? data.event : "";
      if ((event === "answer_chunk" || event === "degraded") && firstByteMs === null) firstByteMs = performance.now() - startedAt;
      if (event === "answer_chunk") {
        const delta = (data as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
        if (typeof delta === "string") answerText += delta;
        return;
      }
      if (event !== "done") return;
      completionMs = performance.now() - startedAt;
      finalState = typeof data.finalState === "string" ? data.finalState : "no_done";
      observedCacheHit = typeof data.cacheHit === "boolean" ? data.cacheHit : undefined;
      if (isRecord(data.stages)) {
        stages = {
          keywordMs: numberOrZero(data.stages.keywordMs),
          searchMs: numberOrZero(data.stages.searchMs),
          generationMs: numberOrZero(data.stages.generationMs),
        };
      }
      if (Array.isArray(data.sources)) {
        sources = data.sources.filter(isRecord).map((source) => ({
          title: typeof source.title === "string" ? source.title : "",
          url: typeof source.url === "string" ? source.url : "",
          ...(typeof source.sourceType === "string" ? { sourceType: source.sourceType } : {}),
        })).filter((source) => source.title !== "" && source.url !== "");
      }
      if (Array.isArray(data.keywords)) keywords = data.keywords.filter((k): k is string => typeof k === "string");
      if (typeof data.searched === "boolean") searched = data.searched;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        for (const line of buffer.slice(0, boundary).split("\n")) processLine(line);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    for (const line of buffer.split("\n")) processLine(line);
    if (completionMs === 0) completionMs = performance.now() - startedAt;
    const status = finalState === "answered" || finalState === "degraded" ? finalState : "failed";
    return { ...question, status, completionMs, firstEventMs, firstByteMs, finalState, stages, observedCacheHit, error: null, answer: answerText, sources, keywords, searched };
  } catch (error) {
    return {
      ...question,
      status: "failed",
      completionMs: performance.now() - startedAt,
      firstEventMs,
      firstByteMs,
      finalState: "fetch_error",
      stages,
      observedCacheHit,
      error: error instanceof Error ? error.message : String(error),
      answer: answerText,
      sources,
      keywords,
      searched,
    };
  }
}

async function warmOne(baseUrl: string, question: AskEvaluationQuestion, sessionToken: string | null): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
      },
      body: JSON.stringify({ sessionId: EVAL_SESSION_ID, question: question.question, recentTranscript: question.recentTranscript ?? "", termHint: question.termHint, cacheKey: question.termHint?.trim().toLowerCase() || question.id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const matches = [...text.matchAll(/data:\s*(\{[^\n]+\})/g)];
    for (const match of matches.reverse()) {
      try {
        const payload = JSON.parse(match[1]) as Record<string, unknown>;
        if (payload.event === "done" && typeof payload.finalState === "string") return payload.finalState;
      } catch { /* ignore malformed SSE */ }
    }
    return "no_done";
  } catch {
    // A warm request failure must never kill the whole run; the measured
    // request below still records its own terminal state.
    return "no_done";
  }
}

/** Persists one measured turn (user + assistant) for frontend replay; idempotent by message id. */
async function persistEvalTurn(baseUrl: string, sessionToken: string | null, result: AskEvaluationResult): Promise<boolean> {
  if (!sessionToken) return false;
  const now = new Date().toISOString();
  const messages: Record<string, unknown>[] = [
    {
      id: `ask-eval-${result.id}-user`,
      role: "user",
      content: result.question,
      isDetail: false,
      createdAt: now,
      ...(result.keywords.length > 0 ? { keywords: result.keywords } : {}),
    },
  ];
  if (result.answer.trim() !== "") {
    messages.push({
      id: `ask-eval-${result.id}-assistant`,
      role: "assistant",
      content: result.answer,
      isDetail: false,
      createdAt: now,
      ...(result.sources.length > 0 ? { sources: result.sources } : {}),
      ...(result.keywords.length > 0 ? { keywords: result.keywords } : {}),
      finalState: result.finalState,
    });
  }
  try {
    const response = await fetch(`${baseUrl}/api/chat-messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Token": sessionToken },
      body: JSON.stringify({ sessionId: EVAL_SESSION_ID, messages }),
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const manifestPath = process.env.ASK_EXTENDED_MANIFEST;
  if (!manifestPath) throw new Error("ASK_EXTENDED_MANIFEST is required; no dataset is created automatically");
  const manifest = parseAskEvaluationManifest(await readFile(resolve(manifestPath), "utf8"));
  assertExtendedDatasetSize(manifest);
  const baseUrl = process.env.ASK_MEASURE_BASE_URL ?? DEFAULT_BASE_URL;
  const outputDir = resolve(process.env.ASK_EXTENDED_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);
  const sessionToken = await bootstrapEvalSession(baseUrl);
  const results: AskEvaluationResult[] = [];
  for (const question of manifest.questions) {
    const warmFinalState = question.cacheMode === "hot" ? await warmOne(baseUrl, question, sessionToken) : undefined;
    const result = await measureOne(baseUrl, question, sessionToken);
    if (warmFinalState !== undefined) {
      result.warmFinalState = warmFinalState;
      result.cacheEligible = warmFinalState === "answered";
    }
    results.push(result);
    result.persisted = await persistEvalTurn(baseUrl, sessionToken, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  const summary = summarizeAskResults(results);
  const manifestOutput = {
    evaluator: "ask-extended-evaluator-v1",
    generatedAt: new Date().toISOString(),
    sourceManifest: resolve(manifestPath),
    datasetVersion: manifest.datasetVersion ?? manifest.version,
    questionCount: manifest.questions.length,
    baseUrl,
    cacheModes: ["cold", "hot"],
    evidenceBoundary: "Only questions supplied by the manifest are measured. The evaluator does not create, expand, or rewrite the dataset and does not clear application caches.",
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(`${outputDir}/manifest.json`, manifestOutput),
    writeJson(`${outputDir}/scorecard.json`, summary),
    writeJsonl(`${outputDir}/cases.jsonl`, results),
    writeFile(`${outputDir}/report.md`, renderReport(manifestOutput, summary), "utf8"),
  ]);
  process.stdout.write(`Ask extended evaluation report written to ${outputDir}\n`);
}

function summarizeMode(results: AskEvaluationResult[]): ModeSummary {
  return {
    denominator: { total: results.length, failed: results.filter((result) => result.status === "failed").length },
    completionMs: percentiles(results.map((result) => result.completionMs).filter(isFiniteNumber)),
    firstEventMs: percentiles(results.map((result) => result.firstEventMs).filter(isFiniteNumber)),
    firstByteMs: percentiles(results.map((result) => result.firstByteMs).filter(isFiniteNumber)),
    finalStates: countBy(results, (result) => result.finalState),
    cacheModeMismatches: results.filter((result) => result.observedCacheHit !== undefined && ((result.cacheMode === "cold" && result.observedCacheHit) || (result.cacheMode === "hot" && result.cacheEligible === true && !result.observedCacheHit))).length,
  };
}

function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function renderReport(manifest: Record<string, unknown>, summary: AskEvaluationSummary): string {
  return [
    "# CueMind Extended Live Ask Evaluation",
    "",
    `- Dataset version: \`${String(manifest.datasetVersion)}\``,
    `- Questions: ${String(manifest.questionCount)}`,
    `- Denominator: ${JSON.stringify(summary.denominator)}`,
    `- Completion: ${JSON.stringify(summary.completionMs)}`,
    `- First event: ${JSON.stringify(summary.firstEventMs)}`,
    `- First byte: ${JSON.stringify(summary.firstByteMs)}`,
    "",
    "## Cache Modes",
    "",
    `- cold: ${JSON.stringify(summary.byCacheMode.cold)}`,
    `- hot: ${JSON.stringify(summary.byCacheMode.hot)}`,
    "",
    String(manifest.evidenceBoundary),
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function numberOrZero(value: unknown): number { return isFiniteNumber(value) ? value : 0; }
async function writeJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function writeJsonl(path: string, values: unknown[]): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, values.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8"); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
