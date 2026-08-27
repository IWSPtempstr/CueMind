import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export interface LocalAsrRequest {
  whisperPath: string;
  modelPath: string;
  audioPath: string;
  language: "auto" | "zh" | "en";
  timeoutMs?: number;
}

export interface LocalAsrSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LocalAsrResult {
  text: string;
  latencyMs: number;
  audioDurationMs: number | null;
  realTimeFactor: number | null;
  segments: LocalAsrSegment[];
  provider: "local-whisper";
  modelPath: string;
}

export async function transcribeWithWhisperCpp(
  request: LocalAsrRequest,
): Promise<LocalAsrResult> {
  const started = performance.now();
  const outputDir = await mkdtemp(join(tmpdir(), "cuemind-asr-"));
  const outputBase = join(outputDir, basename(request.audioPath).replace(/\.[^.]+$/, "") || "transcript");
  try {
    const args = ["-m", request.modelPath, "-f", request.audioPath, "-oj", "-otxt", "-of", outputBase, "-nt"];
    if (request.language !== "auto") args.push("-l", request.language);

    const processOutput = await runProcess(request.whisperPath, args, request.timeoutMs ?? 60_000);
    const segments = await readJsonSegments(`${outputBase}.json`);
    const text = segments.length > 0
      ? segments.map((segment) => segment.text).join(" ").trim()
      : await readTextOutput(`${outputBase}.txt`, processOutput);
    const latencyMs = Math.round(performance.now() - started);
    const audioDurationMs = await readWavDurationMs(request.audioPath);
    return {
      text,
      latencyMs,
      audioDurationMs,
      realTimeFactor: audioDurationMs && audioDurationMs > 0 ? latencyMs / audioDurationMs : null,
      segments,
      provider: "local-whisper",
      modelPath: request.modelPath,
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Local ASR timed out after ${timeoutMs} milliseconds`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start local ASR: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(classifyProcessError(stderr, code)));
    });
  });
}

async function readJsonSegments(path: string): Promise<LocalAsrSegment[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !Array.isArray(value.transcription)) return [];
    return value.transcription.flatMap((item) => {
      if (!isRecord(item) || typeof item.text !== "string") return [];
      const startMs = parseTimestamp(item.offsets, "from");
      const endMs = parseTimestamp(item.offsets, "to");
      return startMs !== null && endMs !== null
        ? [{ startMs, endMs, text: item.text.trim() }]
        : [];
    }).filter((segment) => segment.text.length > 0);
  } catch {
    return [];
  }
}

async function readTextOutput(path: string, stdout: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return stdout.trim();
  }
}

async function readWavDurationMs(path: string): Promise<number | null> {
  try {
    const header = await readFile(path);
    if (header.length < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const dataOffset = findWavChunk(header, "data");
    if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0 || dataOffset === null) return null;
    const dataBytes = header.readUInt32LE(dataOffset + 4);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    return bytesPerSecond > 0 ? Math.round((dataBytes / bytesPerSecond) * 1000) : null;
  } catch {
    return null;
  }
}

function findWavChunk(buffer: Buffer, chunkId: string): number | null {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4);
    if (buffer.toString("ascii", offset, offset + 4) === chunkId) return offset;
    offset += 8 + size + (size % 2);
  }
  return null;
}

function parseTimestamp(value: unknown, key: "from" | "to"): number | null {
  if (!isRecord(value) || typeof value[key] !== "number" || !Number.isFinite(value[key])) return null;
  return Math.max(0, Math.round(value[key]));
}

function classifyProcessError(stderr: string, code: number | null): string {
  const message = stderr.trim();
  if (/model/i.test(message) && /(not found|failed|cannot|unable)/i.test(message)) {
    return `Local ASR model error: ${message}`;
  }
  if (/audio|wav|file/i.test(message) && /(not found|failed|cannot|unable|invalid)/i.test(message)) {
    return `Local ASR audio input error: ${message}`;
  }
  return message || `Local ASR exited with code ${code ?? "unknown"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Media -> WAV conversion (ffmpeg based, independent from whisper pipeline) ---

export type MediaConvertErrorCode =
  | "ffmpeg_not_found"
  | "unsupported_media"
  | "ffmpeg_timed_out"
  | "ffmpeg_failed";

export class MediaConvertError extends Error {
  readonly code: MediaConvertErrorCode;

  constructor(code: MediaConvertErrorCode, message: string) {
    super(message);
    this.name = "MediaConvertError";
    this.code = code;
  }
}

export interface ConvertMediaOptions {
  /** Path to the ffmpeg executable. Defaults to "ffmpeg". */
  ffmpegPath?: string;
  /** Optional trim start in milliseconds (applied before -i as -ss seconds). */
  startMs?: number;
  /** Optional trim end in milliseconds; requires startMs to be provided too. */
  endMs?: number;
  /** Kill switch for the ffmpeg subprocess. Defaults to 600_000 ms. */
  timeoutMs?: number;
}

export interface ConvertMediaResult {
  wavPath: string;
  originalDurationMs: number | null;
}

const SUPPORTED_MEDIA_EXTENSIONS = [
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

const SUPPORTED_MEDIA_FORMATS_LABEL = SUPPORTED_MEDIA_EXTENSIONS.join(", ");
const MEDIA_EXTENSIONS_SET = new Set<string>(SUPPORTED_MEDIA_EXTENSIONS);
const DEFAULT_FFMPEG_TIMEOUT_MS = 600_000;
const FFMPEG_STDERR_SUMMARY_LIMIT = 500;

export async function convertMediaToWav(
  inputPath: string,
  outputWavPath: string,
  options?: ConvertMediaOptions,
): Promise<ConvertMediaResult> {
  const extension = getInputFileExtension(inputPath);
  // Classification happens before any subprocess is started.
  if (!MEDIA_EXTENSIONS_SET.has(extension)) {
    throw new MediaConvertError(
      "unsupported_media",
      `Unsupported media format "${extension ? `.${extension}` : "(no extension)"}". Supported formats: ${SUPPORTED_MEDIA_FORMATS_LABEL}.`,
    );
  }

  if (extension === "wav") {
    return { wavPath: inputPath, originalDurationMs: await readWavDurationMs(inputPath) };
  }

  const startMs = normalizeTrimMs(options?.startMs);
  const endMs = normalizeTrimMs(options?.endMs);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const command = options?.ffmpegPath ?? "ffmpeg";

  const args: string[] = ["-y"];
  if (startMs !== null) args.push("-ss", formatSeconds(startMs));
  args.push("-i", inputPath);
  if (startMs !== null && endMs !== null && endMs > startMs) {
    args.push("-t", formatSeconds(endMs - startMs));
  }
  args.push("-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputWavPath);

  const outcome = await runFfmpegProcess(command, args, timeoutMs);
  if (outcome.timedOut) {
    throw new MediaConvertError("ffmpeg_timed_out", `ffmpeg media conversion timed out after ${timeoutMs} milliseconds`);
  }
  if (
    outcome.spawnErrorCode === "ENOENT"
    || /command not found/i.test(outcome.stderr)
  ) {
    throw new MediaConvertError(
      "ffmpeg_not_found",
      `ffmpeg executable was not found ("${command}"). Install ffmpeg or configure its path.${summarizeFfmpegStderr(outcome.stderr)}`,
    );
  }
  if (outcome.exitCode !== 0) {
    throw new MediaConvertError(
      "ffmpeg_failed",
      `ffmpeg exited with code ${outcome.exitCode ?? "unknown"}${summarizeFfmpegStderr(outcome.stderr)}`,
    );
  }

  const durationMs = await readWavDurationMs(outputWavPath);
  if (durationMs === null) {
    throw new MediaConvertError("ffmpeg_failed", `ffmpeg did not produce a valid WAV file at "${outputWavPath}"`);
  }
  return { wavPath: outputWavPath, originalDurationMs: durationMs };
}

interface FfmpegProcessOutcome {
  exitCode: number | null;
  spawnErrorCode: string | null;
  timedOut: boolean;
  stderr: string;
}

function runFfmpegProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<FfmpegProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const settle = (outcome: Omit<FfmpegProcessOutcome, "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      settle({ exitCode: null, spawnErrorCode: null, timedOut: true });
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      const errorCode = (error as NodeJS.ErrnoException).code;
      settle({
        exitCode: null,
        spawnErrorCode: typeof errorCode === "string" ? errorCode : null,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      settle({ exitCode: code, spawnErrorCode: null, timedOut: false });
    });
  });
}

function getInputFileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === base.length - 1) return "";
  return base.slice(dotIndex + 1).toLowerCase();
}

function normalizeTrimMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toString();
}

function summarizeFfmpegStderr(stderr: string): string {
  const detail = stderr.trim();
  if (!detail) return "";
  const summary = detail.length > FFMPEG_STDERR_SUMMARY_LIMIT
    ? `${detail.slice(0, FFMPEG_STDERR_SUMMARY_LIMIT)}...`
    : detail;
  return ` (${summary})`;
}
