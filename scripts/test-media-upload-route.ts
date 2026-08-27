// Regression tests for app/api/upload-media/route.ts.
// Runs without starting the Next dev server: imports the route's core handler
// from lib/upload-media.ts and exercises happy path, size guards, format
// whitelist, missing fields, and converter-error status mapping using injected
// fake processing stages.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertUploadSize,
  handleUploadMedia,
  MAX_UPLOAD_BYTES,
} from "@/lib/upload-media";
import type { UploadMediaErrorPayload, UploadMediaSuccessPayload } from "@/lib/upload-media";
import { MediaConvertError } from "@/lib/local-asr";
import type { LocalAsrSegment } from "@/lib/local-asr";

// Minimal fake conversion stage used by non-happy-path cases.
const STUB_PROCESS_AUDIO = async (
  _inputPath: string,
  outputWavPath: string,
): Promise<{ wavPath: string; originalDurationMs: number | null }> => ({
  wavPath: outputWavPath,
  originalDurationMs: 0,
});

const STUB_TRANSCRIBE = async (): Promise<{ segments: LocalAsrSegment[] }> => ({
  segments: [],
});

function countUploadTempDirs(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("cuemind-upload-")).length;
}

function buildUploadForm(file?: File): FormData {
  const form = new FormData();
  if (file) form.append("media", file);
  form.append("whisperPath", "/opt/fake-whisper");
  form.append("whisperModelPath", "/models/fake-small.bin");
  form.append("uploadId", "test-upload-1");
  return form;
}

function createTestFile(bytes: number, name: string, type: string): File {
  const fileConstructor = globalThis.File;
  if (typeof fileConstructor !== "function") {
    throw new Error("Runtime lacks a File constructor (Node >= 20 required)");
  }
  return new fileConstructor([Buffer.alloc(bytes)], name, { type });
}

async function testSuccessPathWithCleanup(): Promise<void> {
  const uploadId = "c99f7b62-1111-4bbb-9ccc-9999aaaa0001";
  const segments: LocalAsrSegment[] = [
    { startMs: 0, endMs: 3000, text: "hello world" },
    { startMs: 3000, endMs: 6000, text: "second chunk" },
    { startMs: 6000, endMs: 8500, text: "third chunk" },
  ];

  const form = new FormData();
  form.append("media", createTestFile(128, "lecture.mp4", "video/mp4"));
  form.append("whisperPath", "/opt/fake-whisper");
  form.append("whisperModelPath", "/models/fake-small.bin");
  form.append("uploadId", uploadId);
  form.append("language", "zh");
  form.append("ffmpegPath", "/usr/bin/fake-ffmpeg");

  const response = await handleUploadMedia(form, {
    processAudio: async (_inputPath, outputWavPath) => ({
      wavPath: outputWavPath,
      originalDurationMs: 12345,
    }),
    transcribe: async () => ({ segments }),
  });

  assert.equal(response.status, 200, "success path must respond 200");
  const payload = await response.json() as UploadMediaSuccessPayload;
  assert.equal(payload.uploadId, uploadId, "uploadId must round-trip");
  assert.equal(payload.fileName, "lecture.mp4", "original fileName must be echoed");
  assert.equal(payload.originalDurationMs, 12345);
  assert.equal(payload.segmentCount, segments.length);
  assert.equal(payload.chunks.length, segments.length);

  payload.chunks.forEach((chunk, index) => {
    assert.deepEqual(chunk, {
      startMs: segments[index].startMs,
      endMs: segments[index].endMs,
      text: segments[index].text,
      audioChunkId: `${uploadId}-${index}`,
      source: "upload",
    });
  });
  assert.equal(payload.chunks[0].audioChunkId.endsWith("-0"), true, "first chunk id must be <uploadId>-0");

  // The finally-block cleanup must leave zero temp dirs behind.
  assert.equal(countUploadTempDirs(), 0, "no cuemind-upload-* temp dir may survive a completed request");
}

async function testHeaderBasedSizeGuard(): Promise<void> {
  const oversize = assertUploadSize(
    new Headers({ "content-length": String(MAX_UPLOAD_BYTES + 1) }),
  );
  assert.ok(oversize, "oversized declared Content-Length must yield a 413 response");
  assert.equal(oversize.status, 413);
  const payload = await oversize.json() as UploadMediaErrorPayload;
  assert.equal(payload.error, "Media exceeds the 2048MB limit");
  assert.equal(payload.code, "upload_too_large");

  // Boundary: exactly at the cap is allowed through.
  assert.equal(assertUploadSize(new Headers({ "content-length": String(MAX_UPLOAD_BYTES) })), null);
  // Unknown length falls through to the post-parse File.size check.
  assert.equal(assertUploadSize(new Headers()), null);
}

async function testFileSizeGuard(): Promise<void> {
  const oversize = assertUploadSize(MAX_UPLOAD_BYTES + 1);
  assert.ok(oversize, "oversized parsed File.size must yield a 413 response");
  assert.equal(oversize.status, 413);
  const payload = await oversize.json() as UploadMediaErrorPayload;
  assert.equal(payload.code, "upload_too_large");
  assert.equal(assertUploadSize(MAX_UPLOAD_BYTES), null);
  assert.equal(assertUploadSize(1024), null);
}

async function testUnsupportedFormatRejected(): Promise<void> {
  const form = new FormData();
  form.append("media", createTestFile(32, "notes.txt", "text/plain"));
  form.append("whisperPath", "/opt/fake-whisper");
  form.append("whisperModelPath", "/models/fake-small.bin");
  form.append("uploadId", "test-upload-fmt");

  const response = await handleUploadMedia(form, {
    processAudio: STUB_PROCESS_AUDIO,
    transcribe: STUB_TRANSCRIBE,
  });

  assert.equal(response.status, 415, ".txt upload must be rejected as unsupported format");
  const payload = await response.json() as UploadMediaErrorPayload;
  assert.equal(payload.error, "Unsupported media format");
  assert.equal(payload.code, "unsupported_format");
}

async function testMissingFieldsRejected(): Promise<void> {
  const response = await handleUploadMedia(new FormData());
  assert.equal(response.status, 400, "empty body must fail required-field validation");
  const payload = await response.json() as UploadMediaErrorPayload;
  assert.equal(typeof payload.error === "string" && payload.error.length > 0, true);
}

async function testConverterErrorMapping(): Promise<void> {
  const ffmpegNotFoundForm = buildUploadForm(createTestFile(16, "clip.mp3", "audio/mpeg"));
  const notFoundResponse = await handleUploadMedia(ffmpegNotFoundForm, {
    processAudio: async () => {
      throw new MediaConvertError("ffmpeg_not_found", 'ffmpeg executable was not found ("ffmpeg").');
    },
    transcribe: STUB_TRANSCRIBE,
  });
  assert.equal(notFoundResponse.status, 502);
  const notFoundPayload = await notFoundResponse.json() as UploadMediaErrorPayload;
  assert.equal(notFoundPayload.code, "ffmpeg_not_found");

  const passthroughForm = buildUploadForm(createTestFile(16, "song.wav", "audio/wav"));
  const unsupportedResponse = await handleUploadMedia(passthroughForm, {
    processAudio: async () => {
      throw new MediaConvertError("unsupported_media", 'Unsupported media format ".xyz".');
    },
    transcribe: STUB_TRANSCRIBE,
  });
  assert.equal(unsupportedResponse.status, 415, "unsupported_media from converter maps to 415");
  const unsupportedPayload = await unsupportedResponse.json() as UploadMediaErrorPayload;
  assert.equal(unsupportedPayload.code, "unsupported_media");

  const whisperFailureForm = buildUploadForm(createTestFile(16, "talk.m4a", "audio/m4a"));
  const genericResponse = await handleUploadMedia(whisperFailureForm, {
    processAudio: STUB_PROCESS_AUDIO,
    transcribe: async () => {
      throw new Error("Local ASR timed out after 600000 milliseconds");
    },
  });
  assert.equal(genericResponse.status, 502, "plain whisper Errors map to 502");
  const genericPayload = await genericResponse.json() as UploadMediaErrorPayload;
  assert.match(genericPayload.error ?? "", /timed out/);
}

async function runCase(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`failed - ${name}`);
    console.error(error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await runCase("success path returns mapped chunks and cleans temp dir", () => testSuccessPathWithCleanup());
  await runCase("declared Content-Length over limit yields 413", () => testHeaderBasedSizeGuard());
  await runCase("parsed File.size over limit yields 413", () => testFileSizeGuard());
  await runCase("non-whitelisted extension yields 415 unsupported_format", () => testUnsupportedFormatRejected());
  await runCase("missing required fields yields 400", () => testMissingFieldsRejected());
  await runCase("converter/whisper errors map to correct statuses", () => testConverterErrorMapping());
  console.log("media upload route regression tests passed");
}

void main();
