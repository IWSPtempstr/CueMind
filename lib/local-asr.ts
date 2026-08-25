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
