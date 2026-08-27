// Streaming upload pipeline helper: slices the ffmpeg-produced intermediate WAV
// (16 kHz / mono / pcm_s16le, fixed format guaranteed by convertMediaToWav) into
// fixed-duration window files so whisper can transcribe each window as soon as
// it is ready instead of waiting for the whole media file.
//
// Parsing is deliberately strict: any deviation from RIFF/WAVE with a 16-byte
// PCM fmt chunk at 16 kHz mono 16-bit is reported as an "ffmpeg_failed" style
// error because only convertMediaToWav output ever reaches this module.

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MediaConvertError } from "@/lib/local-asr";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
/** s16le mono → 2 bytes per sample frame. */
export const WAV_BYTES_PER_FRAME = CHANNELS * (BITS_PER_SAMPLE / 8);
/** 16000 frames/s × 2 bytes/frame ÷ 1000 ms/s = 32 bytes per millisecond. */
export const WAV_BYTES_PER_MS = (SAMPLE_RATE * WAV_BYTES_PER_FRAME) / 1000;
/** Canonical minimal PCM WAV header size ("RIFF"…fmt + data fields). */
export const WAV_HEADER_BYTES = 44;

export interface ParsedWavPcm {
  /** Absolute byte offset of the PCM payload inside the buffer. */
  dataOffset: number;
  /** Byte length of the PCM payload (declared chunk size clamped to real bytes). */
  dataLength: number;
  durationMs: number;
}

function invalidWav(reason: string): MediaConvertError {
  return new MediaConvertError("ffmpeg_failed", `Converted media produced an invalid WAV file: ${reason}`);
}

/**
 * Strict RIFF/WAVE parser for the fixed pipeline format:
 * fmt(16, PCM=1, 16000 Hz, channels=1, bits=16) followed by a data chunk.
 * Extra metadata chunks are tolerated; structural violations throw.
 */
export function parseWavPcm16kMono(buffer: Buffer): ParsedWavPcm {
  if (buffer.length < WAV_HEADER_BYTES) {
    throw invalidWav(`file is too short (${buffer.length} bytes)`);
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw invalidWav("missing RIFF/WAVE header");
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset: number | null = null;
  let declaredDataBytes = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || bodyStart + 16 > buffer.length) {
        throw invalidWav("truncated fmt chunk");
      }
      format = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      declaredDataBytes = chunkSize;
    }
    // Chunks are word-aligned: odd sizes carry one padding byte.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!format) throw invalidWav("missing fmt chunk");
  if (
    format.audioFormat !== 1
    || format.channels !== CHANNELS
    || format.sampleRate !== SAMPLE_RATE
    || format.bitsPerSample !== BITS_PER_SAMPLE
  ) {
    throw invalidWav(
      `expected ${BITS_PER_SAMPLE}-bit PCM mono at ${SAMPLE_RATE} Hz, got format=${format.audioFormat} channels=${format.channels} rate=${format.sampleRate} bits=${format.bitsPerSample}`,
    );
  }
  if (dataOffset === null) throw invalidWav("missing data chunk");

  const dataLength = Math.min(declaredDataBytes, Math.max(0, buffer.length - dataOffset));
  if (dataLength <= 0) throw invalidWav("data chunk is empty");
  if (dataLength % WAV_BYTES_PER_FRAME !== 0) throw invalidWav("data length is not sample-frame aligned");

  return {
    dataOffset,
    dataLength,
    durationMs: Math.floor(dataLength / WAV_BYTES_PER_MS),
  };
}

/** Builds the canonical 44-byte PCM WAV header for 16 kHz mono 16-bit data. */
export function buildWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * WAV_BYTES_PER_FRAME, 28); // byte rate
  header.writeUInt16LE(WAV_BYTES_PER_FRAME, 32); // block align
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Pure slice over an in-memory WAV buffer. Returns complete standalone WAV
 * buffers (44-byte header + payload). When the content fits within a single
 * window the original buffer is returned unchanged (passthrough).
 * Boundary windows stay whole and odd tail windows are simply shorter — every
 * window keeps frame alignment because window bytes are a multiple of 2.
 */
export function sliceWavToWindowBuffers(buffer: Buffer, windowMs: number): Buffer[] {
  const parsed = parseWavPcm16kMono(buffer);
  const bytesPerWindow = Math.floor(windowMs * WAV_BYTES_PER_MS);
  if (bytesPerWindow <= 0 || parsed.dataLength <= bytesPerWindow) {
    return [buffer];
  }

  const windows: Buffer[] = [];
  for (let start = 0; start < parsed.dataLength; start += bytesPerWindow) {
    const end = Math.min(start + bytesPerWindow, parsed.dataLength);
    const slice = Buffer.from(
      buffer.subarray(parsed.dataOffset + start, parsed.dataOffset + end),
    );
    windows.push(Buffer.concat([buildWavHeader(slice.length), slice]));
  }
  return windows;
}

/**
 * File-level wrapper used by lib/upload-media.ts: streams the converted WAV
 * from disk in fixed-size chunks instead of buffering it whole, then either
 * passes it through untouched (≤ single window) or writes one legal standalone
 * WAV per window into tmpDir. Caller owns tmpDir cleanup; files are named
 * "upload-window-0000.wav", "upload-window-0001.wav", …
 *
 * Every window's byte size is known up front from the parsed data-chunk length
 * (fixed-size windows plus a shorter tail), so each window file gets its
 * canonical header written first and the exact payload range copied after —
 * byte-identical to the in-memory sliceWavToWindowBuffers output.
 */
export async function sliceWavToWindowFiles(
  wavPath: string,
  windowMs: number,
  tmpDir: string,
): Promise<string[]> {
  const file = await open(wavPath, "r");
  try {
    const fileSize = (await file.stat()).size;
    const layout = await parseWavLayoutFromFile(file, fileSize);
    const bytesPerWindow = Math.floor(windowMs * WAV_BYTES_PER_MS);
    if (
      bytesPerWindow <= 0
      || layout.durationMs <= windowMs
      || layout.dataLength <= bytesPerWindow
    ) {
      return [wavPath];
    }

    const windowCount = Math.ceil(layout.dataLength / bytesPerWindow);
    const windowPaths: string[] = [];
    // Reused 4 MiB copy block; every source byte is read exactly once.
    const copyBuffer = Buffer.alloc(STREAM_COPY_CHUNK_BYTES);
    let sourcePos = layout.dataOffset;

    for (let index = 0; index < windowCount; index += 1) {
      const windowDataBytes = Math.min(bytesPerWindow, layout.dataLength - index * bytesPerWindow);
      const windowPath = join(tmpDir, `upload-window-${String(index).padStart(4, "0")}.wav`);
      const out = await open(windowPath, "w");
      try {
        // Positional writes (pwrite) do not move the file cursor, so every
        // write carries an explicit offset: header first, payload after it.
        await out.write(buildWavHeader(windowDataBytes), 0, WAV_HEADER_BYTES, 0);
        let remaining = windowDataBytes;
        while (remaining > 0) {
          const want = Math.min(copyBuffer.length, remaining);
          const { bytesRead } = await file.read(copyBuffer, 0, want, sourcePos);
          if (bytesRead <= 0) {
            throw invalidWav("data chunk is truncated");
          }
          await out.write(copyBuffer, 0, bytesRead, WAV_HEADER_BYTES + (windowDataBytes - remaining));
          sourcePos += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await out.close();
      }
      windowPaths.push(windowPath);
    }
    return windowPaths;
  } finally {
    await file.close();
  }
}

/** 4 MiB streaming copy block shared across all window writes. */
const STREAM_COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const WAV_CHUNK_HEADER_BYTES = 8;
const WAV_FMT_BODY_BYTES = 16;

interface WavStreamLayout {
  /** Absolute file offset of the PCM payload. */
  dataOffset: number;
  /** Byte length of the PCM payload (declared chunk size clamped to real bytes). */
  dataLength: number;
  durationMs: number;
}

/** Reads exactly `length` bytes at `position`; throws invalidWav on early EOF. */
async function readWavBytesAt(
  file: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, position + read);
    if (bytesRead <= 0) {
      throw invalidWav("unexpected end of file while reading the WAV structure");
    }
    read += bytesRead;
  }
}

/**
 * Streaming counterpart of parseWavPcm16kMono for on-disk files: walks only the
 * chunk headers (seeking past chunk bodies) so the PCM payload is never
 * buffered, with the exact same strict validation and error messages.
 */
async function parseWavLayoutFromFile(
  file: FileHandle,
  fileSize: number,
): Promise<WavStreamLayout> {
  if (fileSize < WAV_HEADER_BYTES) {
    throw invalidWav(`file is too short (${fileSize} bytes)`);
  }
  const probe = Buffer.alloc(WAV_FMT_BODY_BYTES);
  await readWavBytesAt(file, probe, 12, 0);
  if (probe.toString("ascii", 0, 4) !== "RIFF" || probe.toString("ascii", 8, 12) !== "WAVE") {
    throw invalidWav("missing RIFF/WAVE header");
  }

  let format: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset: number | null = null;
  let declaredDataBytes = 0;

  let offset = 12;
  while (offset + WAV_CHUNK_HEADER_BYTES <= fileSize) {
    await readWavBytesAt(file, probe, WAV_CHUNK_HEADER_BYTES, offset);
    const chunkId = probe.toString("ascii", 0, 4);
    const chunkSize = probe.readUInt32LE(4);
    const bodyStart = offset + WAV_CHUNK_HEADER_BYTES;
    if (chunkId === "fmt ") {
      if (chunkSize < WAV_FMT_BODY_BYTES || bodyStart + WAV_FMT_BODY_BYTES > fileSize) {
        throw invalidWav("truncated fmt chunk");
      }
      await readWavBytesAt(file, probe, WAV_FMT_BODY_BYTES, bodyStart);
      format = {
        audioFormat: probe.readUInt16LE(0),
        channels: probe.readUInt16LE(2),
        sampleRate: probe.readUInt32LE(4),
        bitsPerSample: probe.readUInt16LE(14),
      };
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      declaredDataBytes = chunkSize;
    }
    // Chunks are word-aligned: odd sizes carry one padding byte.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!format) throw invalidWav("missing fmt chunk");
  if (
    format.audioFormat !== 1
    || format.channels !== CHANNELS
    || format.sampleRate !== SAMPLE_RATE
    || format.bitsPerSample !== BITS_PER_SAMPLE
  ) {
    throw invalidWav(
      `expected ${BITS_PER_SAMPLE}-bit PCM mono at ${SAMPLE_RATE} Hz, got format=${format.audioFormat} channels=${format.channels} rate=${format.sampleRate} bits=${format.bitsPerSample}`,
    );
  }
  if (dataOffset === null) throw invalidWav("missing data chunk");

  const dataLength = Math.min(declaredDataBytes, Math.max(0, fileSize - dataOffset));
  if (dataLength <= 0) throw invalidWav("data chunk is empty");
  if (dataLength % WAV_BYTES_PER_FRAME !== 0) throw invalidWav("data length is not sample-frame aligned");

  return {
    dataOffset,
    dataLength,
    durationMs: Math.floor(dataLength / WAV_BYTES_PER_MS),
  };
}

