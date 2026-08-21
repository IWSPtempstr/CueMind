import { NextResponse } from "next/server";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";

export const runtime = "nodejs";

interface LocalTranscribeBody {
  audioPath: string;
  source: "system" | "microphone";
  startMs: number;
  endMs: number;
  settings: {
    whisperPath: string;
    modelPath: string;
    language: "auto" | "zh" | "en";
  };
}

export async function POST(
  request: Request,
): Promise<NextResponse<{ text: string; latencyMs: number } | { error: string }>> {
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
  if (value.source !== "system" && value.source !== "microphone") return null;
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return null;
  if (!isRecord(value.settings)) return null;
  if (!isString(value.settings.whisperPath) || !value.settings.whisperPath.trim()) return null;
  if (!isString(value.settings.modelPath) || !value.settings.modelPath.trim()) return null;
  const language = value.settings.language;
  if (language !== "auto" && language !== "zh" && language !== "en") return null;

  return {
    audioPath: value.audioPath,
    source: value.source,
    startMs: value.startMs,
    endMs: value.endMs,
    settings: {
      whisperPath: value.settings.whisperPath,
      modelPath: value.settings.modelPath,
      language,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
