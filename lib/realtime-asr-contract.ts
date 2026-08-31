export const REALTIME_ASR_EVENT_TYPES = ["partial", "confirmed", "final", "error", "recovered"] as const;
export type RealtimeAsrEventType = (typeof REALTIME_ASR_EVENT_TYPES)[number];

export interface RealtimeAsrEvent {
  runId: string;
  segmentId: string;
  type: RealtimeAsrEventType;
  text: string;
  startMs: number;
  endMs: number;
  errorCode?: string;
}

export enum RealtimeAsrState {
  Listening = "listening",
  Recovering = "recovering",
  Finalized = "finalized",
  Failed = "failed",
}

export interface RealtimeAsrStateSnapshot {
  runId: string;
  confirmedUntilMs: number;
  confirmedSegmentIds: string[];
  partialText: string | null;
  status: RealtimeAsrState;
}

export function parseRealtimeAsrEvent(value: unknown): RealtimeAsrEvent | null {
  if (!isRecord(value) || typeof value.runId !== "string" || !value.runId.trim() || typeof value.segmentId !== "string" || !value.segmentId.trim()) return null;
  if (!REALTIME_ASR_EVENT_TYPES.includes(value.type as RealtimeAsrEventType) || typeof value.text !== "string" || !value.text.trim()) return null;
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs) || value.startMs < 0 || value.endMs < value.startMs) return null;
  return {
    runId: value.runId.trim(), segmentId: value.segmentId.trim(), type: value.type as RealtimeAsrEventType,
    text: value.text.trim(), startMs: Math.round(value.startMs), endMs: Math.round(value.endMs),
    ...(typeof value.errorCode === "string" && value.errorCode.trim() ? { errorCode: value.errorCode.trim() } : {}),
  };
}

export function createRealtimeAsrState(runId: string): RealtimeAsrStateSnapshot {
  if (!runId.trim()) throw new Error("runId is required");
  return { runId: runId.trim(), confirmedUntilMs: 0, confirmedSegmentIds: [], partialText: null, status: RealtimeAsrState.Listening };
}

export function ingestRealtimeAsrEvent(state: RealtimeAsrStateSnapshot, event: RealtimeAsrEvent): RealtimeAsrStateSnapshot {
  if (event.runId !== state.runId) throw new Error("runId mismatch");
  if (event.endMs < event.startMs) throw new Error("timestamp range invalid");
  if (event.type === "partial") return { ...state, partialText: event.text };
  if (event.type === "confirmed") {
    if (state.confirmedSegmentIds.includes(event.segmentId)) throw new Error("duplicate confirmed segment");
    if (event.endMs < state.confirmedUntilMs) throw new Error("confirmed watermark regressed");
    return { ...state, confirmedUntilMs: Math.max(state.confirmedUntilMs, event.endMs), confirmedSegmentIds: [...state.confirmedSegmentIds, event.segmentId], partialText: null };
  }
  if (event.type === "final") return { ...state, status: RealtimeAsrState.Finalized, partialText: null };
  if (event.type === "error") return { ...state, status: RealtimeAsrState.Failed, partialText: null };
  return { ...state, status: RealtimeAsrState.Recovering };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
