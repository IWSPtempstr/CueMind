// Core implementation behind app/api/upload-media/route.ts.
// Kept out of the route file because Next.js Route Handlers may only export
// HTTP methods plus framework config fields — this module houses the testable
// helpers (handleUploadMedia / assertUploadSize / constants / payload types).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  convertMediaToWav,
  MediaConvertError,
  transcribeWithWhisperCpp,
} from "@/lib/local-asr";
import type { ConvertMediaOptions, LocalAsrSegment } from "@/lib/local-asr";
import { sliceWavToWindowFiles } from "@/lib/wav-slice";

/** Hard upload cap: 2048MB, enforced both by header pre-check and post-parse File.size. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const WHISPER_TIMEOUT_MS = 600_000;
const TEMP_DIR_PREFIX = "cuemind-upload-";

const SUPPORTED_UPLOAD_EXTENSIONS = [
  "mp4",
  "webm",
  "mov",
  "mkv",
  "m4a",
  "mp3",
  "flac",
  "ogg",
  "wav",
] as const;
const SUPPORTED_EXTENSIONS_SET = new Set<string>(SUPPORTED_UPLOAD_EXTENSIONS);

export interface UploadedMediaChunk {
  startMs: number;
  endMs: number;
  text: string;
  audioChunkId: string;
  source: "upload";
}

export interface UploadMediaSuccessPayload {
  uploadId: string;
  fileName: string;
  originalDurationMs: number | null;
  segmentCount: number;
  chunks: UploadedMediaChunk[];
}

export type UploadMediaErrorPayload = { error: string; code?: string };

export interface UploadMediaOverrides {
  /**
   * Test seam replacing the real convertMediaToWav step.
   * Receives (temporary input path, wav output path, convert options) and must report
   * where the converted WAV actually landed (wav passthrough reuses the input path).
   */
  processAudio?: (
    inputPath: string,
    outputWavPath: string,
    options: ConvertMediaOptions,
  ) => Promise<{ wavPath: string; originalDurationMs: number | null }>;
  /** Test seam replacing the real transcribeWithWhisperCpp step. */
  transcribe?: (wavPath: string) => Promise<{ segments: LocalAsrSegment[] }>;
}

interface ParsedUploadFields {
  file: File;
  language: "auto" | "zh" | "en";
  whisperPath: string;
  whisperModelPath: string;
  uploadId: string;
  ffmpegPath?: string;
}

type ParseOutcome =
  | { ok: true; fields: ParsedUploadFields }
  | { ok: false; response: NextResponse<UploadMediaErrorPayload> };

/**
 * Size guard shared by the header pre-check and the post-parse File.size check.
 * Pass a byte count directly, or a headers-like object exposing get(name)
 * (e.g. Request.headers). Returns a ready-to-send 413 response, or null when
 * processing may continue.
 */
export function assertUploadSize(
  source: number | { get(name: string): string | null | undefined },
): NextResponse<UploadMediaErrorPayload> | null {
  let sizeBytes: number;
  if (typeof source === "number") {
    sizeBytes = source;
  } else {
    const declared = source.get("content-length");
    if (!declared) return null; // Unknown length: fall through to the File.size check later.
    sizeBytes = Number(declared);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= MAX_UPLOAD_BYTES) return null;
  return NextResponse.json(
    { error: "Media exceeds the 2048MB limit", code: "upload_too_large" },
    { status: 413 },
  );
}

export async function handleUploadMedia(
  formData: FormData,
  overrides?: UploadMediaOverrides,
): Promise<NextResponse<UploadMediaSuccessPayload | UploadMediaErrorPayload>> {
  const parsed = parseUploadFields(formData);
  if (!parsed.ok) return parsed.response;

  const fields = parsed.fields;

  // Second size check with the actual parsed byte count, in case Content-Length was absent.
  const oversizeByFileSize = assertUploadSize(fields.file.size);
  if (oversizeByFileSize) return oversizeByFileSize;

  const processAudio = overrides?.processAudio ?? defaultProcessAudio;
  const transcribe = overrides?.transcribe ?? defaultTranscribe(fields);

  try {
    const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    try {
      const extension = getFileExtension(fields.file.name);
      const inputPath = join(tempDir, `${randomUUID()}${extension ? `.${extension}` : ""}`);
      await writeFile(inputPath, Buffer.from(await fields.file.arrayBuffer()));

      const wavOutputPath = join(tempDir, "media-16k.wav");
      const converted = await processAudio(inputPath, wavOutputPath, {
        ffmpegPath: fields.ffmpegPath,
      });
      const wavPath = converted.wavPath || wavOutputPath;

      const transcription = await transcribe(wavPath);
      const segments = transcription.segments ?? [];
      const chunks: UploadedMediaChunk[] = segments.map(
        (segment, index): UploadedMediaChunk => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          audioChunkId: `${fields.uploadId}-${index}`,
          source: "upload",
        }),
      );

      return NextResponse.json({
        uploadId: fields.uploadId,
        fileName: fields.file.name,
        originalDurationMs: converted.originalDurationMs ?? null,
        segmentCount: chunks.length,
        chunks,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (caught) {
    return mapProcessingError(caught);
  }
}

function parseUploadFields(formData: FormData): ParseOutcome {
  const media = formData.get("media");
  if (!media || typeof media === "string") {
    return fail("A media file is required");
  }

  if (!isSupportedUploadMedia(media.name, media.type)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unsupported media format", code: "unsupported_format" },
        { status: 415 },
      ),
    };
  }

  const whisperPath = trimmedString(formData.get("whisperPath"));
  const whisperModelPath = trimmedString(formData.get("whisperModelPath"));
  const uploadId = trimmedString(formData.get("uploadId"));
  if (!whisperPath || !whisperModelPath || !uploadId) {
    return fail("whisperPath, whisperModelPath, and uploadId are required");
  }

  let language: ParsedUploadFields["language"] = "auto";
  const rawLanguage = formData.get("language");
  if (rawLanguage !== null && rawLanguage !== "") {
    if (typeof rawLanguage !== "string" || !isTranscriptLanguage(rawLanguage)) {
      return fail('language must be one of: "auto", "zh", "en"');
    }
    language = rawLanguage;
  }

  const rawFfmpegPath = formData.get("ffmpegPath");
  const ffmpegPath =
    typeof rawFfmpegPath === "string" && rawFfmpegPath.trim()
      ? rawFfmpegPath.trim()
      : undefined;

  return {
    ok: true,
    fields: { file: media, language, whisperPath, whisperModelPath, uploadId, ffmpegPath },
  };
}

function isSupportedUploadMedia(fileName: string, mimeType: string): boolean {
  // Hard condition: the file extension must be whitelisted. Files without a usable
  // extension are rejected even when their MIME type looks like audio/video.
  const extensionInWhitelist = SUPPORTED_EXTENSIONS_SET.has(getFileExtension(fileName));
  // MIME rule: accept audio/* or video/* types. Combined gate per API contract:
  // extension-in-whitelist AND at least one of (extension whitelisted | allowed MIME).
  const mimeAllowed = mimeType.startsWith("audio/") || mimeType.startsWith("video/");
  return extensionInWhitelist && (extensionInWhitelist || mimeAllowed);
}

function getFileExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === base.length - 1) return "";
  return base.slice(dotIndex + 1).toLowerCase();
}

function isTranscriptLanguage(value: string): value is ParsedUploadFields["language"] {
  return value === "auto" || value === "zh" || value === "en";
}

function trimmedString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

async function defaultProcessAudio(
  inputPath: string,
  outputWavPath: string,
  options: ConvertMediaOptions,
): Promise<{ wavPath: string; originalDurationMs: number | null }> {
  const result = await convertMediaToWav(inputPath, outputWavPath, options);
  return { wavPath: result.wavPath, originalDurationMs: result.originalDurationMs };
}

function defaultTranscribe(
  fields: ParsedUploadFields,
  signal?: AbortSignal,
): (wavPath: string) => Promise<{ segments: LocalAsrSegment[] }> {
  return (wavPath) =>
    transcribeWithWhisperCpp({
      audioPath: wavPath,
      whisperPath: fields.whisperPath,
      modelPath: fields.whisperModelPath,
      language: fields.language,
      timeoutMs: WHISPER_TIMEOUT_MS,
      // Client disconnects kill the running whisper subprocess (runProcess
      // listens on this signal); the route's SSE wrapper then closes silently.
      signal,
    });
}

function mapProcessingError(caught: unknown): NextResponse<UploadMediaErrorPayload> {
  if (caught instanceof MediaConvertError) {
    return NextResponse.json(
      { error: caught.message, code: caught.code },
      { status: caught.code === "unsupported_media" ? 415 : 502 },
    );
  }
  const message =
    caught instanceof Error && caught.message.trim()
      ? caught.message
      : "Local ASR failed while processing the uploaded media";
  return NextResponse.json({ error: message }, { status: 502 });
}

function fail(message: string): ParseOutcome {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status: 400 }),
  };
}

// ---------------------------------------------------------------------------
// Streaming pipeline (opt-in via FormData field stream=1 in the route).
// Converts the media once, slices the resulting WAV into fixed windows and
// yields one event per transcribed window so the client can render progress
// incrementally. The legacy handleUploadMedia above stays untouched for
// old clients / existing regression tests.
// ---------------------------------------------------------------------------

/** Transcription window length for the streaming pipeline. */
export const STREAM_WINDOW_MS = 60_000;

export interface WindowResultEvent {
  type: "window";
  uploadId: string;
  /** Zero-based window index. */
  windowIndex: number;
  /** Predicted total number of windows, null when unknowable up front. */
  totalWindows: number | null;
  chunks: UploadedMediaChunk[];
}

export interface StreamDoneEvent {
  type: "done";
  uploadId: string;
  fileName: string;
  originalDurationMs: number | null;
  segmentCount: number;
}

export interface StreamErrorEvent {
  type: "error";
  message: string;
  code?: string;
}

export type UploadStreamEvent = WindowResultEvent | StreamDoneEvent;

export interface UploadStreamOptions extends UploadMediaOverrides {
  /**
   * Aborting stops scheduling further transcription windows; the generator's
   * finally block then removes the temp directory with every window file.
   */
  signal?: AbortSignal;
}

/** Error carrying an optional machine-readable code, rethrown through the route into a StreamErrorEvent. */
export class UploadStreamFailure extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "UploadStreamFailure";
    this.code = code;
  }
}

/** whisper.cpp sometimes emits this placeholder segment instead of real text; treat it as silence. */
const FOREIGN_LANGUAGE_PLACEHOLDER = "(speaking in foreign language)";

function isSkippableSegmentText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed === FOREIGN_LANGUAGE_PLACEHOLDER) return true;
  // Punctuation/whitespace-only segments carry no content — drop them.
  return !/\p{L}|\p{N}/u.test(trimmed);
}

async function failureFromResponse(
  response: NextResponse<UploadMediaErrorPayload>,
): Promise<UploadStreamFailure> {
  const payload = await response.json() as UploadMediaErrorPayload;
  return new UploadStreamFailure(payload.error ?? "Upload rejected", payload.code);
}

/**
 * Streaming counterpart of handleUploadMedia: same validation chain (field
 * parsing, size guard), same dependency seams (processAudio / transcribe), but
 * yields one WindowResultEvent per finished whisper window followed by one
 * StreamDoneEvent. Validation or processing failures are thrown; the route is
 * expected to translate thrown errors into a terminal StreamErrorEvent.
 */
export async function* processUploadStreaming(
  formData: FormData,
  overrides?: UploadStreamOptions,
): AsyncGenerator<UploadStreamEvent> {
  const parsed = parseUploadFields(formData);
  if (!parsed.ok) throw await failureFromResponse(parsed.response);

  const fields = parsed.fields;

  // Second size check with the actual parsed byte count (mirrors the JSON path).
  const oversizeByFileSize = assertUploadSize(fields.file.size);
  if (oversizeByFileSize) throw await failureFromResponse(oversizeByFileSize);

  const processAudio = overrides?.processAudio ?? defaultProcessAudio;
  const transcribe = overrides?.transcribe ?? defaultTranscribe(fields, overrides?.signal);

  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    const extension = getFileExtension(fields.file.name);
    const inputPath = join(tempDir, `${randomUUID()}${extension ? `.${extension}` : ""}`);
    await writeFile(inputPath, Buffer.from(await fields.file.arrayBuffer()));

    const wavOutputPath = join(tempDir, "media-16k.wav");
    const converted = await processAudio(inputPath, wavOutputPath, {
      ffmpegPath: fields.ffmpegPath,
    });
    const wavPath = converted.wavPath || wavOutputPath;

    // ≤ single window → passthrough without slicing (one standalone event either way).
    const windowFiles = await sliceWavToWindowFiles(wavPath, STREAM_WINDOW_MS, tempDir);

    let segmentCount = 0;
    for (const [windowIndex, windowFile] of windowFiles.entries()) {
      if (overrides?.signal?.aborted) return;
      const transcription = await transcribe(windowFile);
      if (overrides?.signal?.aborted) return;

      const offsetMs = windowIndex * STREAM_WINDOW_MS;
      const chunks = (transcription.segments ?? [])
        .map((segment, index): UploadedMediaChunk => ({
          startMs: offsetMs + segment.startMs,
          endMs: offsetMs + segment.endMs,
          text: segment.text.trim(),
          audioChunkId: `${fields.uploadId}-w${windowIndex}-${index}`,
          source: "upload" as const,
        }))
        .filter((chunk) => !isSkippableSegmentText(chunk.text));

      segmentCount += chunks.length;
      yield {
        type: "window",
        uploadId: fields.uploadId,
        windowIndex,
        totalWindows: windowFiles.length,
        chunks,
      };
    }

    yield {
      type: "done",
      uploadId: fields.uploadId,
      fileName: fields.file.name,
      originalDurationMs: converted.originalDurationMs ?? null,
      segmentCount,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
