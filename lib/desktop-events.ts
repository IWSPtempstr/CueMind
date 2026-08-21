import type { AudioSource } from "@/types/session";

export type DesktopEvent = AudioChunkReadyEvent | TranscriptReadyEvent | RuntimeErrorEvent | RuntimeStatusEvent;

export interface AudioChunkReadyEvent {
  type: "audio_chunk_ready";
  id: string;
  source: AudioSource;
  path: string;
  startedAt: string;
  endedAt: string;
  startMs: number;
  endMs: number;
  sampleRate: number;
  channels: number;
}

export interface TranscriptReadyEvent {
  type: "transcript_ready";
  id: string;
  audioChunkId: string;
  source: AudioSource;
  text: string;
  timestamp: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  latencyMs?: number;
}

export interface RuntimeErrorEvent {
  type: "runtime_error";
  code: string;
  message: string;
  occurredAt: string;
}

export interface RuntimeStatusEvent {
  type: "runtime_status";
  status: string;
  occurredAt: string;
  source?: AudioSource;
  outputDir?: string;
}

export function parseDesktopEvent(raw: string): DesktopEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  if (parsed.type === "audio_chunk_ready") return parseAudioChunkReady(parsed);
  if (parsed.type === "transcript_ready") return parseTranscriptReady(parsed);
  if (parsed.type === "runtime_error") return parseRuntimeError(parsed);
  if (parsed.type === "runtime_status") return parseRuntimeStatus(parsed);
  return null;
}

function parseAudioChunkReady(event: Record<string, unknown>): AudioChunkReadyEvent | null {
  if (
    !isString(event.id) ||
    !isAudioSource(event.source) ||
    !isString(event.path) ||
    !isString(event.startedAt) ||
    !isString(event.endedAt) ||
    !isFiniteNumber(event.startMs) ||
    !isFiniteNumber(event.endMs) ||
    !isFiniteNumber(event.sampleRate) ||
    !isFiniteNumber(event.channels)
  ) return null;
  return {
    type: "audio_chunk_ready",
    id: event.id,
    source: event.source,
    path: event.path,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    startMs: event.startMs,
    endMs: event.endMs,
    sampleRate: event.sampleRate,
    channels: event.channels,
  };
}

function parseTranscriptReady(event: Record<string, unknown>): TranscriptReadyEvent | null {
  if (
    !isString(event.id) ||
    !isString(event.audioChunkId) ||
    !isAudioSource(event.source) ||
    !isString(event.text) ||
    !isString(event.timestamp) ||
    !isFiniteNumber(event.startMs) ||
    !isFiniteNumber(event.endMs)
  ) return null;
  return {
    type: "transcript_ready",
    id: event.id,
    audioChunkId: event.audioChunkId,
    source: event.source,
    text: event.text,
    timestamp: event.timestamp,
    startMs: event.startMs,
    endMs: event.endMs,
    ...(isFiniteNumber(event.confidence) ? { confidence: event.confidence } : {}),
    ...(isFiniteNumber(event.latencyMs) ? { latencyMs: event.latencyMs } : {}),
  };
}

function parseRuntimeError(event: Record<string, unknown>): RuntimeErrorEvent | null {
  if (!isString(event.code) || !isString(event.message) || !isString(event.occurredAt)) return null;
  return {
    type: "runtime_error",
    code: event.code,
    message: event.message,
    occurredAt: event.occurredAt,
  };
}

function parseRuntimeStatus(event: Record<string, unknown>): RuntimeStatusEvent | null {
  if (!isString(event.status) || !isString(event.occurredAt)) return null;
  return {
    type: "runtime_status",
    status: event.status,
    occurredAt: event.occurredAt,
    ...(isAudioSource(event.source) ? { source: event.source } : {}),
    ...(isString(event.outputDir) ? { outputDir: event.outputDir } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAudioSource(value: unknown): value is AudioSource {
  return value === "system" || value === "microphone";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
