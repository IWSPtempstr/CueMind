import { access, constants as fsConstants, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export interface LocalAsrRequest {
  whisperPath: string;
  modelPath: string;
  audioPath: string;
  language: "auto" | "zh" | "en";
  timeoutMs?: number;
  /** Aborting kills the whisper subprocess; the promise rejects with "Local ASR aborted". */
  signal?: AbortSignal;
  /** Optional prompt-biasing context (meeting topic + comma separated domain glossary). */
  promptContext?: { topic?: string; glossary?: string };
  /** Optional Silero VAD configuration; missing VAD model silently degrades to no VAD. */
  vad?: { enabled: boolean; modelPath: string };
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

    // Hallucination suppression + decoding tuning (fixed values, no settings surface).
    args.push("--suppress-nst", "--max-context", "128", "--entropy-thold", "2.8");

    const prompt = buildInitialPrompt(request.promptContext);
    if (prompt) {
      args.push("--prompt", prompt, "--carry-initial-prompt");
    }

    args.push(...(await resolveVadArgs(request.vad)));

    const processOutput = await runProcess(request.whisperPath, args, request.timeoutMs ?? 60_000, request.signal);
    const segments = filterHallucinatedSegments(await readJsonSegments(`${outputBase}.json`));
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

/** Hard budget for the initial prompt (whisper caps it at n_text_ctx/2 tokens ≈ 200 chars). */
const MAX_INITIAL_PROMPT_CHARS = 200;
/** Chinese subtitle-site boilerplate and other hallucination patterns dropped outright. */
const HALLUCINATION_BLOCKLIST = /字幕由|Amara\.org|字幕by|索兰娅|谢谢观看|请订阅|请点赞|关注频道/i;

/**
 * Builds the whisper initial prompt from the meeting topic and domain glossary:
 * "以下是普通话的句子，这是一场关于<topic>的技术会议，可能提及：<terms>。"
 * Returns null when neither topic nor glossary is provided.
 */
function buildInitialPrompt(promptContext?: LocalAsrRequest["promptContext"]): string | null {
  const topic = promptContext?.topic?.trim() ?? "";
  const glossary = promptContext?.glossary?.trim() ?? "";
  if (!topic && !glossary) return null;

  const glossaryTerms = glossary
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .join("、");
  const prompt = glossaryTerms
    ? `以下是普通话的句子，这是一场关于${topic || "技术讨论"}的技术会议，可能提及：${glossaryTerms}。`
    : `以下是普通话的句子，这是一场关于${topic || "技术讨论"}的技术会议。`;
  // Over-budget prompts are truncated from the end so the fixed template head
  // and the earliest (most important) glossary terms survive.
  return prompt.length > MAX_INITIAL_PROMPT_CHARS ? prompt.slice(0, MAX_INITIAL_PROMPT_CHARS) : prompt;
}

const warnedVadModelPaths = new Set<string>();

/** Resolves `--vad --vad-model <path>` args; silently degrades when the model file is missing. */
async function resolveVadArgs(vad?: LocalAsrRequest["vad"]): Promise<string[]> {
  if (!vad?.enabled || !vad.modelPath.trim()) return [];
  const modelPath = vad.modelPath.trim();
  try {
    await access(modelPath, fsConstants.F_OK);
  } catch {
    if (!warnedVadModelPaths.has(modelPath)) {
      warnedVadModelPaths.add(modelPath);
      console.warn(`[local-asr] VAD model not found at "${modelPath}"; continuing without VAD.`);
    }
    return [];
  }
  return ["--vad", "--vad-model", modelPath];
}

/**
 * Post-processes whisper segments: drops subtitle-boilerplate hallucinations and
 * empty texts, then collapses runs of >=3 consecutive identical segments
 * (whitespace-normalized) down to the first occurrence.
 */
export function filterHallucinatedSegments(segments: LocalAsrSegment[]): LocalAsrSegment[] {
  const ordered = segments
    .filter((segment) => segment.text.trim().length > 0 && !HALLUCINATION_BLOCKLIST.test(segment.text.trim()))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const result: LocalAsrSegment[] = [];
  const normalizedText = (segment: LocalAsrSegment): string => segment.text.replace(/\s+/g, "");
  for (let index = 0; index < ordered.length; ) {
    let runEnd = index + 1;
    while (runEnd < ordered.length && normalizedText(ordered[runEnd]) === normalizedText(ordered[index])) {
      runEnd += 1;
    }
    if (runEnd - index >= 3) {
      result.push(ordered[index]);
    } else {
      for (let cursor = index; cursor < runEnd; cursor += 1) result.push(ordered[cursor]);
    }
    index = runEnd;
  }
  return result;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const detachAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    // Abort kills the subprocess immediately; the settled guard keeps this
    // one-shot against the timeout/close/error races.
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachAbort();
      child.kill();
      reject(new Error("Local ASR aborted"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detachAbort();
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
      detachAbort();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start local ASR: ${error.message}`));
    });
    child.on("close", (code) => {
      detachAbort();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(classifyProcessError(stderr, code)));
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
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
    // ffmpeg prints one of these patterns when the input media carries no
    // audio track at all (e.g. a silent video); give it a friendly message.
    if (/does not contain any stream|matches no streams|Stream map/i.test(outcome.stderr)) {
      throw new MediaConvertError(
        "ffmpeg_failed",
        `该文件没有可用的音频轨道，无法进行语音转写（ffmpeg: ${summarizeFfmpegStderrBody(outcome.stderr)}）`,
      );
    }
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

/** Truncated raw stderr summary without surrounding punctuation. */
function summarizeFfmpegStderrBody(stderr: string): string {
  const detail = stderr.trim();
  if (!detail) return "";
  return detail.length > FFMPEG_STDERR_SUMMARY_LIMIT
    ? `${detail.slice(0, FFMPEG_STDERR_SUMMARY_LIMIT)}...`
    : detail;
}

function summarizeFfmpegStderr(stderr: string): string {
  const summary = summarizeFfmpegStderrBody(stderr);
  if (!summary) return "";
  return ` (${summary})`;
}
