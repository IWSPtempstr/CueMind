// Regression tests for app/api/upload-media/route.ts.
// Runs without starting the Next dev server: imports the route's core handler
// from lib/upload-media.ts and exercises happy path, size guards, format
// whitelist, missing fields, and converter-error status mapping using injected
// fake processing stages.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUploadSize,
  handleUploadMedia,
  MAX_UPLOAD_BYTES,
  STREAM_WINDOW_MS,
  processUploadStreaming,
} from "@/lib/upload-media";
import type {
  StreamDoneEvent,
  UploadMediaErrorPayload,
  UploadMediaSuccessPayload,
  UploadStreamEvent,
  WindowResultEvent,
} from "@/lib/upload-media";
import { MediaConvertError } from "@/lib/local-asr";
import type { LocalAsrSegment } from "@/lib/local-asr";
import {
  buildWavHeader,
  parseWavPcm16kMono,
  sliceWavToWindowBuffers,
  sliceWavToWindowFiles,
  WAV_BYTES_PER_MS,
} from "@/lib/wav-slice";

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

// ---------------------------------------------------------------------------
// Streaming pipeline + wav-slice helpers
// ---------------------------------------------------------------------------

function buildWavBuffer(durationMs: number, sampleRate = 16_000): Buffer {
  const dataBytes = Math.floor(durationMs * (sampleRate * 2) / 1000);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function createWavFile(durationMs: number, name: string): File {
  const fileConstructor = globalThis.File;
  if (typeof fileConstructor !== "function") {
    throw new Error("Runtime lacks a File constructor (Node >= 20 required)");
  }
  const wav = buildWavBuffer(durationMs);
  return new fileConstructor([new Uint8Array(wav)], name, { type: "video/mp4" });
}

function buildStreamingForm(file: File): FormData {
  const form = new FormData();
  form.append("media", file);
  form.append("whisperPath", "/opt/fake-whisper");
  form.append("whisperModelPath", "/models/fake-small.bin");
  form.append("uploadId", "stream-upload-1");
  form.append("stream", "1");
  return form;
}

/** processAudio 注入：把指定时长的合法 16kHz WAV 写到 outputWavPath。 */
function fakeProcessAudioWritingWav(
  durationMs: number,
): NonNullable<Parameters<typeof processUploadStreaming>[1]>["processAudio"] {
  return async (_inputPath, outputWavPath) => {
    await writeFile(outputWavPath, buildWavBuffer(durationMs));
    return { wavPath: outputWavPath, originalDurationMs: durationMs };
  };
}

async function collectStreamEvents(form: FormData, overrides?: Parameters<typeof processUploadStreaming>[1]): Promise<UploadStreamEvent[]> {
  const events: UploadStreamEvent[] = [];
  for await (const event of processUploadStreaming(form, overrides)) {
    events.push(event);
  }
  return events;
}

function filterWindows(events: UploadStreamEvent[]): WindowResultEvent[] {
  return events.filter((event): event is WindowResultEvent => event.type === "window");
}

function filterDone(events: UploadStreamEvent[]): StreamDoneEvent[] {
  return events.filter((event): event is StreamDoneEvent => event.type === "done");
}

async function testStreamingWindowsAndDone(): Promise<void> {
  // 150s → ceil(150/60) = 3 窗（60/60/30，奇数尾窗）。
  const totalDurationMs = 150_000;
  const uploadId = "stream-upload-1";
  const transcribeCalls: string[] = [];

  const form = buildStreamingForm(createWavFile(totalDurationMs, "lecture.mp4"));
  const events = await collectStreamEvents(form, {
    processAudio: fakeProcessAudioWritingWav(totalDurationMs),
    transcribe: async (wavPath) => {
      transcribeCalls.push(wavPath);
      const windowIndex = transcribeCalls.length - 1;
      return {
        segments: [
          { startMs: 500, endMs: 1500, text: `窗${windowIndex}文本` },
          // 应被跳过的噪音段：外语占位符与纯标点空白。
          { startMs: 2000, endMs: 2100, text: "(speaking in foreign language)" },
          { startMs: 2200, endMs: 2300, text: "，。！？ " },
        ] satisfies LocalAsrSegment[],
      };
    },
  });

  const windowEvents = filterWindows(events);
  const doneEvents = filterDone(events);

  assert.equal(doneEvents.length, 1, "exactly one done event is required");
  assert.equal(windowEvents.length, Math.ceil(totalDurationMs / STREAM_WINDOW_MS), "window count must match duration division");
  assert.equal(events[events.length - 1].type, "done", "done must be the final event");
  assert.deepEqual(transcribeCalls.length, windowEvents.length, "transcribe must run once per window, sequentially");

  // 每窗事件断言：windowIndex/totalWindows/offset 时间戳/audioChunkId w 标记/空段过滤。
  windowEvents.forEach((event, index) => {
    assert.equal(event.uploadId, uploadId);
    assert.equal(event.windowIndex, index, "window indexes must be sequential from 0");
    assert.equal(event.totalWindows, windowEvents.length);
    assert.equal(event.chunks.length, 1, "noise segments must be filtered per window");
    const chunk = event.chunks[0];
    assert.deepEqual(chunk, {
      startMs: index * STREAM_WINDOW_MS + 500,
      endMs: index * STREAM_WINDOW_MS + 1500,
      text: `窗${index}文本`,
      audioChunkId: `${uploadId}-w${index}-0`,
      source: "upload",
    });
    assert.match(chunk.audioChunkId, new RegExp(`-w${index}-`), "audioChunkId must carry the w<window> marker");
  });

  const done = doneEvents[0];
  assert.equal(done.uploadId, uploadId);
  assert.equal(done.fileName, "lecture.mp4");
  assert.equal(done.originalDurationMs, totalDurationMs);
  assert.equal(done.segmentCount, windowEvents.reduce((sum, event) => sum + event.chunks.length, 0), "segmentCount must accumulate every yielded chunk");

  assert.equal(countUploadTempDirs(), 0, "no cuemind-upload-* temp dir may survive a streaming request");
}

async function testStreamingSingleWindowPassthrough(): Promise<void> {
  const form = buildStreamingForm(createWavFile(30_000, "short-clip.mp4"));
  const events = await collectStreamEvents(form, {
    processAudio: fakeProcessAudioWritingWav(30_000),
    transcribe: async () => ({ segments: [{ startMs: 0, endMs: 4000, text: "唯一窗口" }] }),
  });

  const windowEvents = filterWindows(events);
  assert.equal(windowEvents.length, 1, "duration ≤ one window must yield exactly one window event");
  assert.equal(windowEvents[0].totalWindows, 1);
  assert.equal(windowEvents[0].chunks[0].startMs, 0, "single passthrough window must not be offset");
  const doneEvents = filterDone(events);
  assert.equal(doneEvents.length, 1, "done event required");
  assert.equal(doneEvents[0].segmentCount, 1);
  assert.equal(countUploadTempDirs(), 0);
}

async function testStreamingErrorPropagation(): Promise<void> {
  const ffmpegFailureForm = buildStreamingForm(createTestFile(64, "broken.mp4", "video/mp4"));
  await assert.rejects(
    collectStreamEvents(ffmpegFailureForm, {
      processAudio: async () => {
        throw new MediaConvertError("ffmpeg_not_found", 'ffmpeg executable was not found ("ffmpeg").');
      },
      transcribe: STUB_TRANSCRIBE,
    }),
    (caught: unknown) =>
      caught instanceof MediaConvertError
      && caught.code === "ffmpeg_not_found",
    "generator must propagate converter errors to the route wrapper",
  );

  // 非法 WAV 结构：切片阶段必须抛 ffmpeg_failed 类错误。
  const invalidWavForm = buildStreamingForm(createTestFile(64, "garbage.mp4", "video/mp4"));
  await assert.rejects(
    collectStreamEvents(invalidWavForm, {
      processAudio: async (_inputPath, outputWavPath) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(outputWavPath, Buffer.from("definitely-not-a-wav-file"));
        return { wavPath: outputWavPath, originalDurationMs: null };
      },
      transcribe: STUB_TRANSCRIBE,
    }),
    (caught: unknown) =>
      caught instanceof MediaConvertError
      && caught.code === "ffmpeg_failed"
      && /invalid WAV/i.test(caught.message),
    "structurally invalid WAV must fail slicing with ffmpeg_failed",
  );
  assert.equal(countUploadTempDirs(), 0, "temp dirs must still be cleaned after streaming failures");
}

async function testSliceBuffersMultiWindow(): Promise<void> {
  const bytesPerWindow = STREAM_WINDOW_MS * WAV_BYTES_PER_MS;

  // 奇数尾部窗：61s → [60s 全窗, 1s 尾窗]。
  const oddTail = sliceWavToWindowBuffers(buildWavBuffer(61_000), STREAM_WINDOW_MS);
  assert.equal(oddTail.length, 2);
  assert.equal(oddTail[0].length, 44 + bytesPerWindow);
  // 尾窗 data 字节数精确推导：61000ms×32B/ms − 1920000 = 32000。
  const expectedTailDataBytes = 61_000 * WAV_BYTES_PER_MS - bytesPerWindow;
  assert.equal(oddTail[1].length, 44 + expectedTailDataBytes);

  // 边界窗：120s 恰好整除 → 2 个满窗，无零长窗。
  const exactBoundary = sliceWavToWindowBuffers(buildWavBuffer(2 * STREAM_WINDOW_MS), STREAM_WINDOW_MS);
  assert.equal(exactBoundary.length, 2);
  for (const window of exactBoundary) {
    assert.equal(window.length, 44 + bytesPerWindow);
    const parsed = parseWavPcm16kMono(window);
    assert.equal(parsed.durationMs, STREAM_WINDOW_MS);
  }

  // 内容完整性：首窗 payload 必须等于原数据前 60s 的字节。
  const source = buildWavBuffer(90_000);
  const sliced = sliceWavToWindowBuffers(source, STREAM_WINDOW_MS);
  const parsedSource = parseWavPcm16kMono(source);
  assert.equal(sliced.length, 2);
  assert.deepEqual(sliced[0].subarray(44), source.subarray(parsedSource.dataOffset, parsedSource.dataOffset + bytesPerWindow));
  assert.deepEqual(sliced[1].subarray(44), source.subarray(parsedSource.dataOffset + bytesPerWindow, parsedSource.dataOffset + parsedSource.dataLength));

  // 单窗直通：30s ≤ 60s → 原样返回同一引用，不重写头。
  const short = buildWavBuffer(30_000);
  const passthrough = sliceWavToWindowBuffers(short, STREAM_WINDOW_MS);
  assert.equal(passthrough.length, 1);
  assert.equal(passthrough[0], short, "sub-window content must pass through untouched");
}

async function testSliceFilesRoundTrip(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "cuemind-wav-slice-test-"));
  try {
    // 多窗：写出独立合法 WAV 文件。
    const bigWavPath = join(workDir, "big.wav");
    await writeFile(bigWavPath, buildWavBuffer(90_000));
    const windows = await sliceWavToWindowFiles(bigWavPath, STREAM_WINDOW_MS, workDir);
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0], bigWavPath, "multi-window runs must write separate files");
    for (const windowPath of windows) {
      const parsed = parseWavPcm16kMono(await readFile(windowPath));
      assert.ok(parsed.durationMs <= STREAM_WINDOW_MS && parsed.durationMs > 0);
    }
    const tailParsed = parseWavPcm16kMono(await readFile(windows[1]));
    assert.equal(tailParsed.durationMs, 30_000, "odd tail window keeps its real duration");

    // 直通：单窗内容返回原路径且不产生新文件。
    const smallWavPath = join(workDir, "small.wav");
    await writeFile(smallWavPath, buildWavBuffer(45_000));
    const passthrough = await sliceWavToWindowFiles(smallWavPath, STREAM_WINDOW_MS, workDir);
    assert.deepEqual(passthrough, [smallWavPath]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function testSliceFilesMatchBufferSlicing(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "cuemind-wav-slice-compare-"));
  try {
    // 150s → 3 窗（60/60/30），且 4.8MB 源跨过 4MiB 流式拷贝块边界：
    // 流式 sliceWavToWindowFiles 输出必须与整读 sliceWavToWindowBuffers 字节一致。
    const source = buildWavBuffer(150_000);
    const expected = sliceWavToWindowBuffers(source, STREAM_WINDOW_MS);
    assert.equal(expected.length, 3);

    const sourcePath = join(workDir, "source.wav");
    await writeFile(sourcePath, source);
    const files = await sliceWavToWindowFiles(sourcePath, STREAM_WINDOW_MS, workDir);

    assert.equal(files.length, expected.length, "window count must match between streaming and buffer slicing");
    for (const [index, windowPath] of files.entries()) {
      assert.deepEqual(
        await readFile(windowPath),
        expected[index],
        `streamed window ${index} must be byte-identical to buffer slicing`,
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function testSliceRejectsInvalidStructure(): Promise<void> {
  assert.throws(
    () => parseWavPcm16kMono(Buffer.from("RIFFxxxxWAVEjunk")),
    (caught: unknown) => caught instanceof MediaConvertError && caught.code === "ffmpeg_failed",
    "missing fmt/data chunks must fail as ffmpeg_failed",
  );
  // 采样率不符（8kHz）必须拒绝 —— 本管道只接受 16kHz mono s16。
  assert.throws(
    () => parseWavPcm16kMono(buildWavBuffer(1000, 8000)),
    (caught: unknown) => caught instanceof MediaConvertError && caught.code === "ffmpeg_failed",
    "non-16kHz input must be rejected",
  );

  // 语法完整性哨兵：确认 header 构建器与解析器自洽。
  const roundTrip = parseWavPcm16kMono(Buffer.concat([buildWavHeader(2000), Buffer.alloc(2000)]));
  assert.equal(roundTrip.durationMs, 62); // 2000 / 32 ≈ 62ms
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
  await runCase("streaming pipeline yields per-window events then done", () => testStreamingWindowsAndDone());
  await runCase("streaming passthrough for sub-window media", () => testStreamingSingleWindowPassthrough());
  await runCase("streaming errors propagate as thrown failures", () => testStreamingErrorPropagation());
  await runCase("wav buffer slicing splits boundary/odd-tail windows and passes through shorts", () => testSliceBuffersMultiWindow());
  await runCase("wav file slicing writes valid standalone window files", () => testSliceFilesRoundTrip());
  await runCase("streamed file slicing is byte-identical to buffer slicing", () => testSliceFilesMatchBufferSlicing());
  await runCase("wav parser rejects invalid structures", () => testSliceRejectsInvalidStructure());
  console.log("media upload route regression tests passed");
}

void main();
