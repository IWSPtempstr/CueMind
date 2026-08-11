// Proxies multipart audio to Groq Whisper and returns JSON text for chunked client uploads.
// Flow: validate x-groq-api-key → validate multipart audio → call Groq → return { text } or { error }.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit, resolveGroqApiKey } from "@/lib/api-security";
import { groqApiErrorMessage } from "@/lib/groq-route-helpers";
import { MODELS } from "@/lib/prompts";

const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
/** Audio smaller than this is treated as noise and skipped without calling Groq. */
const MIN_AUDIO_BYTES_FOR_GROQ = 1000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIBE_UPLOAD_FILENAME = "chunk.webm";
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

async function isWebm(audio: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await audio.slice(0, 4).arrayBuffer());
  return WEBM_MAGIC.every((byte, index) => bytes[index] === byte);
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ text: string } | { error: string }>> {
  const limited = enforceRateLimit(request, "transcribe", 12);
  if (limited) return limited;

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES + 64_000) {
    return NextResponse.json({ error: "Audio upload is too large" }, { status: 413 });
  }

  const apiKey = resolveGroqApiKey(request);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No API key provided" },
      { status: 401 },
    );
  }

  let incoming: FormData;
  try {
    incoming = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart body" },
      { status: 400 },
    );
  }

  const audio = incoming.get("audio");
  if (!(audio instanceof Blob)) {
    return NextResponse.json(
      { error: "No audio file provided" },
      { status: 400 },
    );
  }

  if (audio.size < MIN_AUDIO_BYTES_FOR_GROQ) {
    return NextResponse.json({ text: "" });
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Audio upload is too large" }, { status: 413 });
  }

  if (!(await isWebm(audio))) {
    return NextResponse.json({ error: "Audio must be a valid WebM file" }, { status: 415 });
  }

  const outbound = new FormData();
  outbound.append("file", audio, TRANSCRIBE_UPLOAD_FILENAME);
  outbound.append("model", MODELS.transcription);
  outbound.append("response_format", "json");
  const language = incoming.get("language");
  if (typeof language === "string" && /^[a-z]{2,3}$/i.test(language)) {
    outbound.append("language", language.toLowerCase());
  }

  let groqResponse: Response;
  try {
    groqResponse = await fetch(GROQ_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: outbound,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach transcription service" },
      { status: 502 },
    );
  }

  const rawText = await groqResponse.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return NextResponse.json(
      { error: "Invalid response from transcription service" },
      { status: 502 },
    );
  }

  if (!groqResponse.ok) {
    const message = groqApiErrorMessage(parsed, "Transcription failed");
    return NextResponse.json({ error: message }, { status: groqResponse.status });
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "text" in parsed &&
    typeof (parsed as { text: unknown }).text === "string"
  ) {
    return NextResponse.json({ text: (parsed as { text: string }).text });
  }

  return NextResponse.json(
    { error: "Invalid transcription response" },
    { status: 502 },
  );
}
