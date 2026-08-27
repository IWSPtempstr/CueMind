import { NextResponse } from "next/server";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";

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

  try {
    const result = await transcribeWithWhisperCpp({
      audioPath: parsed.audioPath,
      whisperPath: parsed.settings.whisperPath,
      modelPath: parsed.settings.modelPath,
      language: parsed.settings.language,
      timeoutMs: parsed.settings.timeoutMs,
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
    },
  };
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
