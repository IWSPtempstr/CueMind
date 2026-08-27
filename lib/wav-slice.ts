// Streaming upload pipeline helper: slices the ffmpeg-produced intermediate WAV
// (16 kHz / mono / pcm_s16le, fixed format guaranteed by convertMediaToWav) into
// fixed-duration window files so whisper can transcribe each window as soon as
// it is ready instead of waiting for the whole media file.
//
// Parsing is deliberately strict: any deviation from RIFF/WAVE with a 16-byte
// PCM fmt chunk at 16 kHz mono 16-bit is reported as an "ffmpeg_failed" style
// error because only convertMediaToWav output ever reaches this module.

import { readFile, writeFile } from "node:fs/promises";
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
 * File-level wrapper used by lib/upload-media.ts: reads the converted WAV once,
 * then either passes it through untouched (≤ single window) or writes one legal
 * standalone WAV per window into tmpDir. Caller owns tmpDir cleanup; files are
 * named "upload-window-0000.wav", "upload-window-0001.wav", …
 */
export async function sliceWavToWindowFiles(
  wavPath: string,
  windowMs: number,
  tmpDir: string,
): Promise<string[]> {
  const buffer = await readFile(wavPath);
  const parsed = parseWavPcm16kMono(buffer);
  if (parsed.durationMs <= windowMs) {
    return [wavPath];
  }

  const windows = sliceWavToWindowBuffers(buffer, windowMs);
  return Promise.all(
    windows.map(async (windowBuffer, index) => {
      const windowPath = join(tmpDir, `upload-window-${String(index).padStart(4, "0")}.wav`);
      await writeFile(windowPath, windowBuffer);
      return windowPath;
    }),
  );
}

