import { NextResponse } from "next/server";
import { ensureWarmedUp, transcribeWithWhisperCpp } from "@/lib/local-asr";

export const runtime = "nodejs";

interface LocalTranscribeBody {
  audioPath: string;
  source: "system" | "microphone" | "upload";
  startMs: number;
  endMs: number;
  settings: {
    whisperPath: string;
    modelPath: string;
    language: "auto" | "zh" | "en";
    timeoutMs?: number;
    promptContext?: { topic?: string; glossary?: string };
    vad?: { enabled: boolean; modelPath: string };
  };
}

export async function POST(
  request: Request,
): Promise<NextResponse<LocalTranscribeResponse | { error: string }>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if (!parsed) {
    return NextResponse.json(
      { error: "audioPath, whisperPath, modelPath, source, and timing fields are required" },
      { status: 400 },
    );
  }

  // 长会话预热（master plan 2.3-b）：fire-and-forget，不 await，保持路由延迟零变化。
  // 首窗请求可能与预热并发执行（whisper-cli 进程级串行由 OS 调度）；预热的价值在于
  // 提前消除 whisper 的 JSON/模型加载冷启动。ensureWarmedUp 内部吞错、永不 reject，
  // 且进程生命周期内仅真实预热一次，void 丢弃不会产生 unhandled rejection。
  void ensureWarmedUp(parsed.settings);

  try {
    const result = await transcribeWithWhisperCpp({
      audioPath: parsed.audioPath,
      whisperPath: parsed.settings.whisperPath,
      modelPath: parsed.settings.modelPath,
      language: parsed.settings.language,
      timeoutMs: parsed.settings.timeoutMs,
      promptContext: parsed.settings.promptContext,
      vad: parsed.settings.vad,
    });
    return NextResponse.json(result);
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : "Local ASR failed" },
      { status: 502 },
    );
  }
}

function parseRequest(value: unknown): LocalTranscribeBody | null {
  if (!isRecord(value) || !isString(value.audioPath) || !value.audioPath.trim()) return null;
  if (value.source !== "system" && value.source !== "microphone" && value.source !== "upload") return null;
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return null;
  if (!isRecord(value.settings)) return null;
  if (!isString(value.settings.whisperPath) || !value.settings.whisperPath.trim()) return null;
  if (!isString(value.settings.modelPath) || !value.settings.modelPath.trim()) return null;
  const language = value.settings.language;
  if (language !== "auto" && language !== "zh" && language !== "en") return null;
  const timeoutMs = value.settings.timeoutMs;
  if (timeoutMs !== undefined && (!isFiniteNumber(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)) return null;

  // Optional, lenient: malformed promptContext/vad are ignored instead of rejected.
  const promptContext = parsePromptContext(value.settings.promptContext);
  const vad = parseVad(value.settings.vad);

  return {
    audioPath: value.audioPath,
    source: value.source,
    startMs: value.startMs,
    endMs: value.endMs,
    settings: {
      whisperPath: value.settings.whisperPath,
      modelPath: value.settings.modelPath,
      language,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(promptContext ? { promptContext } : {}),
      ...(vad ? { vad } : {}),
    },
  };
}

function parsePromptContext(value: unknown): { topic?: string; glossary?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const topic = isString(value.topic) ? value.topic : undefined;
  const glossary = isString(value.glossary) ? value.glossary : undefined;
  if (topic === undefined && glossary === undefined) return undefined;
  return {
    ...(topic !== undefined ? { topic } : {}),
    ...(glossary !== undefined ? { glossary } : {}),
  };
}

function parseVad(value: unknown): { enabled: boolean; modelPath: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.enabled !== "boolean" || !isString(value.modelPath) || !value.modelPath.trim()) return undefined;
  return { enabled: value.enabled, modelPath: value.modelPath };
}

type LocalTranscribeResponse = {
  text: string;
  latencyMs: number;
  audioDurationMs: number | null;
  realTimeFactor: number | null;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  provider: "local-whisper";
  modelPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
