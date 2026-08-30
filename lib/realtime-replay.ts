import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ReplayState = "paused" | "running" | "cancelled" | "completed";
export interface ReplayController { readonly state: ReplayState; readonly position: number; resume(): ReplayController; pause(): ReplayController; cancel(): ReplayController; restart(): ReplayController; next(): number; seek(position: number): ReplayController }

export function createReplayController(total: number): ReplayController {
  let currentState: ReplayState = "paused"; let currentPosition = 0; const max = Math.max(0, Math.floor(total));
  const view = (): ReplayController => ({ get state() { return currentState; }, get position() { return currentPosition; }, resume() { if (currentState !== "cancelled") currentState = "running"; return view(); }, pause() { if (currentState === "running") currentState = "paused"; return view(); }, cancel() { currentState = "cancelled"; return view(); }, restart() { currentPosition = 0; currentState = "paused"; return view(); }, next() { if (currentState !== "running") return currentPosition; currentPosition = Math.min(max, currentPosition + 1); if (currentPosition >= max) currentState = "completed"; return currentPosition; }, seek(position: number) { currentPosition = Math.max(0, Math.min(max, Math.floor(position))); return view(); } });
  return view();
}

export interface LocalTrace { runId: string; stage: string; durationMs: number; status: "ok" | "error"; at: string }
export function createLocalTrace(runId: string, value: { stage: string; durationMs: number; status: "ok" | "error" }): LocalTrace { return { runId, ...value, at: new Date().toISOString() }; }
export function appendLocalTrace(file: string, trace: LocalTrace): void { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(trace)}\n`, "utf8"); }
export function summarizeReplay(traces: LocalTrace[]): { runCount: number; errorCount: number; totalDurationMs: number; averageDurationMs: number } { const totalDurationMs = traces.reduce((sum, trace) => sum + Math.max(0, trace.durationMs), 0); return { runCount: traces.length, errorCount: traces.filter((trace) => trace.status === "error").length, totalDurationMs, averageDurationMs: traces.length ? totalDurationMs / traces.length : 0 }; }
