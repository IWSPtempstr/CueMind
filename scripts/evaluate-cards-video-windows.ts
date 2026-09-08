// 卡片链路真实窗口批量评测：从冻结转写片段（video-reimport 报告）切窗，
// 逐窗走真实 /api/context-cards 链路（关键词 → 真实联网搜索 → 卡片生成，
// 含候选账本 / 去重 / 降级语义），产出与 judge-card-quality.ts 兼容的
// cases.jsonl（card.explanation 由 keyPoints 拼接）+ scorecard + Markdown 报告。
//
// 用法：npx tsx scripts/evaluate-cards-video-windows.ts
// 环境变量：CARDS_EVAL_TRANSCRIPTS_DIR / CARDS_EVAL_TARGET / CARDS_EVAL_OUTPUT_DIR /
//           CARDS_EVAL_BASE_URL / CARDS_EVAL_SESSION_ID
// 密钥从 .env 读取（LLAMA_CPP_BASE_URL / LLAMA_CPP_MODEL / TAVILY_API_KEY）。
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TRANSCRIPTS_DIR = resolve(
  process.env.CARDS_EVAL_TRANSCRIPTS_DIR ??
    "reports/video-reimport-20260830-cuda-zh/transcripts",
);
const TARGET = Number(process.env.CARDS_EVAL_TARGET ?? "40");
const OUTPUT_DIR = resolve(
  process.env.CARDS_EVAL_OUTPUT_DIR ?? "reports/context-card-video-windows-20260908",
);
const BASE_URL = process.env.CARDS_EVAL_BASE_URL ?? "http://localhost:3000";
const SESSION_ID =
  process.env.CARDS_EVAL_SESSION_ID ?? "cards-video-windows-eval-20260908";

const SEGMENTS_PER_BATCH = 6;
const MIN_SEGMENT_CHARS = 40;
const MAX_BATCH_CHARS = 1_800;

interface TranscriptSegment {
  video: string;
  fromSec: number;
  text: string;
}

interface Window {
  id: string;
  video: string;
  fromSec: number;
  text: string;
}

interface CardSource {
  title?: unknown;
  url?: unknown;
}

interface EvalRow {
  id: string;
  video: string;
  fromSec: number;
  finalState: string;
  failureReason: string | null;
  card: {
    keyword: string;
    explanation: string;
    whyNow: string;
  } | null;
  sources: { title: string; url: string }[];
  usableSourceTitles: string[];
  transcriptExcerpt: string;
  latencyMs: { keyword: number; search: number; generation: number; total: number } | null;
}

async function readEnv(name: string): Promise<string> {
  try {
    const raw = await readFile(resolve(".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1).trim();
    }
  } catch { /* .env optional */ }
  return process.env[name] ?? "";
}

async function loadSegments(dir: string): Promise<TranscriptSegment[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no transcript JSON files under ${dir}`);
  const segments: TranscriptSegment[] = [];
  for (const name of files) {
    const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      video?: unknown;
      transcription?: Array<{ offsets?: { from?: unknown }; text?: unknown }>;
    };
    if (typeof raw.video !== "string" || !Array.isArray(raw.transcription)) continue;
    for (const segment of raw.transcription) {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      const from = segment.offsets?.from;
      if (text.length < MIN_SEGMENT_CHARS) continue;
      segments.push({
        video: raw.video,
        fromSec: typeof from === "number" ? Math.round(from / 1000) : 0,
        text,
      });
    }
  }
  return segments;
}

/** 与 build-ask-extended-dataset 相同的 6 段拼窗口径；按视频轮转取样，窗口分布均匀。 */
function buildWindows(segments: TranscriptSegment[], target: number): Window[] {
  const batchesByVideo = new Map<string, TranscriptSegment[][]>();
  let current: TranscriptSegment[] = [];
  const flush = (video: string): void => {
    if (current.length === 0) return;
    const list = batchesByVideo.get(video) ?? [];
    list.push(current);
    batchesByVideo.set(video, list);
    current = [];
  };
  for (const segment of segments) {
    if (current.length >= SEGMENTS_PER_BATCH) flush(current[0].video);
    if (current.length > 0 && current[0].video !== segment.video) flush(current[0].video);
    current.push(segment);
  }
  if (current.length > 0) flush(current[0].video);

  const windows: Window[] = [];
  const videos = [...batchesByVideo.keys()];
  let more = true;
  while (more && windows.length < target) {
    more = false;
    for (const video of videos) {
      const list = batchesByVideo.get(video);
      if (!list || list.length === 0) continue;
      const batch = list.shift()!;
      const text = batch.map((s) => s.text).join(" ").slice(0, MAX_BATCH_CHARS);
      if (text.trim().length < MIN_SEGMENT_CHARS) continue;
      windows.push({
        id: `vw-${String(windows.length + 1).padStart(3, "0")}`,
        video,
        fromSec: batch[0].fromSec,
        text,
      });
      more = true;
      if (windows.length >= target) break;
    }
  }
  return windows;
}

async function bootstrapSession(baseUrl: string): Promise<string | null> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: SESSION_ID,
      title: "Context-card video windows evaluation",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transcriptChunks: [],
      suggestionBatches: [],
      chatMessages: [],
      meetingReport: null,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`session bootstrap HTTP ${response.status}`);
  const payload = (await response.json()) as { sessionAccessToken?: unknown };
  return typeof payload.sessionAccessToken === "string" ? payload.sessionAccessToken : null;
}

async function generateCard(
  baseUrl: string,
  sessionToken: string | null,
  window: Window,
  shownKeywords: string[],
  settings: Record<string, unknown>,
): Promise<EvalRow> {
  const emptyRow: EvalRow = {
    id: window.id,
    video: window.video,
    fromSec: window.fromSec,
    finalState: "no_response",
    failureReason: null,
    card: null,
    sources: [],
    usableSourceTitles: [],
    transcriptExcerpt: window.text.slice(0, 600),
    latencyMs: null,
  };
  try {
    const response = await fetch(`${baseUrl}/api/context-cards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
      },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        recentTranscript: window.text,
        knownKeywords: shownKeywords,
        transcriptChunkIds: [window.id],
        settings,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      return { ...emptyRow, finalState: `http_${response.status}` };
    }
    const payload = (await response.json()) as {
      card?: Record<string, unknown> | null;
      failure?: { reason?: unknown };
      trace?: { finalState?: unknown; totalLatencyMs?: unknown };
    };
    const finalState =
      typeof payload.trace?.finalState === "string" ? payload.trace.finalState : "unknown";
    const latency = (payload.card as { latencyMs?: EvalRow["latencyMs"] } | null)?.latencyMs ?? null;
    const cardRecord = payload.card;
    if (!cardRecord || typeof cardRecord.keyword !== "string") {
      return {
        ...emptyRow,
        finalState,
        failureReason:
          typeof payload.failure?.reason === "string" ? payload.failure.reason : null,
        latencyMs: latency,
      };
    }
    const keyPoints = Array.isArray(cardRecord.keyPoints)
      ? (cardRecord.keyPoints as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const sources = Array.isArray(cardRecord.sources)
      ? (cardRecord.sources as CardSource[])
          .filter((s) => typeof s?.title === "string" && s.title.trim() !== "")
          .map((s) => ({ title: s.title as string, url: typeof s.url === "string" ? s.url : "" }))
      : [];
    return {
      ...emptyRow,
      finalState,
      card: {
        keyword: cardRecord.keyword,
        explanation: keyPoints.join("；"),
        whyNow: typeof cardRecord.whyNow === "string" ? cardRecord.whyNow : "",
      },
      sources,
      usableSourceTitles: sources.map((s) => s.title),
      latencyMs: latency,
    };
  } catch (error) {
    return {
      ...emptyRow,
      finalState: "evaluator_error",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map((v) => JSON.stringify(v)).join("\n") + "\n", "utf8");
}

async function main(): Promise<void> {
  const llamaBaseUrl = await readEnv("LLAMA_CPP_BASE_URL");
  const llamaModel = await readEnv("LLAMA_CPP_MODEL");
  const tavilyKey = await readEnv("TAVILY_API_KEY");
  if (!tavilyKey) throw new Error("TAVILY_API_KEY missing (set it in .env)");

  const segments = await loadSegments(TRANSCRIPTS_DIR);
  const windows = buildWindows(segments, TARGET);
  if (windows.length < TARGET) {
    console.warn(`warning: only ${windows.length} windows available (target ${TARGET})`);
  }
  console.log(`evaluating ${windows.length} windows from ${TRANSCRIPTS_DIR}`);

  const sessionToken = await bootstrapSession(BASE_URL);
  const settings = {
    modelProvider: "llama.cpp",
    llamaCppBaseUrl: llamaBaseUrl,
    llamaCppModel: llamaModel,
    llamaCppApiKey: "",
    remoteApiBaseUrl: "",
    remoteApiModel: "",
    remoteApiApiKey: "",
    searchProvider: "tavily",
    searchApiKey: tavilyKey,
    enableAgentReachFallback: true,
  };

  const shownKeywords: string[] = [];
  const rows: EvalRow[] = [];
  for (const window of windows) {
    const row = await generateCard(BASE_URL, sessionToken, window, shownKeywords, settings);
    if (row.card) shownKeywords.push(row.card.keyword);
    rows.push(row);
    process.stdout.write(
      `${row.id} ${row.finalState}${row.card ? ` ${row.card.keyword}` : ""}\n`,
    );
  }

  const shown = rows.filter((r) => r.card !== null);
  const totals = shown.map((r) => r.latencyMs?.total ?? 0).filter((v) => v > 0);
  const stateCounts: Record<string, number> = {};
  for (const row of rows) stateCounts[row.finalState] = (stateCounts[row.finalState] ?? 0) + 1;

  const scorecard = {
    evaluator: "context-card-video-windows-v1",
    generatedAt: new Date().toISOString(),
    transcriptsDir: TRANSCRIPTS_DIR,
    windows: rows.length,
    finalStates: stateCounts,
    cardShownCount: shown.length,
    cardShownRate: rows.length > 0 ? Number((shown.length / rows.length).toFixed(4)) : 0,
    uniqueKeywords: new Set(shown.map((r) => r.card!.keyword)).size,
    withSources: shown.filter((r) => r.sources.length > 0).length,
    latencyMs: {
      total: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95) },
      keyword: {
        p50: percentile(shown.map((r) => r.latencyMs?.keyword ?? 0), 0.5),
        p95: percentile(shown.map((r) => r.latencyMs?.keyword ?? 0), 0.95),
      },
      generation: {
        p50: percentile(shown.map((r) => r.latencyMs?.generation ?? 0), 0.5),
        p95: percentile(shown.map((r) => r.latencyMs?.generation ?? 0), 0.95),
      },
    },
  };

  await writeJsonl(join(OUTPUT_DIR, "cases.jsonl"), rows);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    join(OUTPUT_DIR, "scorecard.json"),
    `${JSON.stringify(scorecard, null, 2)}\n`,
    "utf8",
  );

  const report = [
    "# Context-Card Video-Windows Evaluation Report",
    "",
    `- Generated at: ${scorecard.generatedAt}`,
    `- Transcripts: ${TRANSCRIPTS_DIR}`,
    `- Windows: ${rows.length}; cards shown: ${shown.length} (${(scorecard.cardShownRate * 100).toFixed(1)}%); unique keywords: ${scorecard.uniqueKeywords}`,
    `- Final states: ${JSON.stringify(stateCounts)}`,
    "",
    "## Metrics",
    "",
    `- total latency P50/P95: ${scorecard.latencyMs.total.p50}/${scorecard.latencyMs.total.p95} ms`,
    `- keyword stage P50/P95: ${scorecard.latencyMs.keyword.p50}/${scorecard.latencyMs.keyword.p95} ms`,
    `- generation stage P50/P95: ${scorecard.latencyMs.generation.p50}/${scorecard.latencyMs.generation.p95} ms`,
    `- cards with sources: ${scorecard.withSources}/${shown.length}`,
    "",
    "## Case Outcomes",
    "",
    "| ID | Video | Final state | Keyword | Sources |",
    "| --- | --- | --- | --- | ---: |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.video} | ${r.finalState} | ${r.card?.keyword ?? "-"} | ${r.sources.length} |`,
    ),
    "",
  ].join("\n");
  await writeFile(join(OUTPUT_DIR, "report.md"), report, "utf8");

  console.log(`cards shown: ${shown.length}/${rows.length}`);
  console.log(`report written to ${OUTPUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
