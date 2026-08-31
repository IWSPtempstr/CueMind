import { percentile } from "@/lib/telemetry";

export const REQUEST_TIMELINE_EVENTS = [
  "request_start", "capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end",
  "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end",
  "first_event", "first_token", "complete",
] as const;
export type RequestTimelineEventName = (typeof REQUEST_TIMELINE_EVENTS)[number];
export interface RequestTimelineEvent { name: RequestTimelineEventName; atMs: number }
export interface RequestTimeline { runId: string; status: string; events: RequestTimelineEvent[] }

export function createRequestTimeline(runId: string, events: RequestTimelineEvent[], status: string): RequestTimeline {
  const timeline = { runId, status, events: [...events].sort((a, b) => a.atMs - b.atMs) };
  validateRequestTimeline(timeline);
  return timeline;
}

export function validateRequestTimeline(timeline: RequestTimeline): { valid: true; durationMs: number } {
  if (!timeline || typeof timeline.runId !== "string" || timeline.runId.trim().length === 0) throw new Error("timeline runId is required");
  if (!Array.isArray(timeline.events) || timeline.events.length === 0) throw new Error("timeline events are required");
  let previous = -Infinity;
  for (const event of timeline.events) {
    if (!REQUEST_TIMELINE_EVENTS.includes(event.name)) throw new Error(`unknown timeline event: ${event.name}`);
    if (!Number.isFinite(event.atMs) || event.atMs < 0) throw new Error(`invalid timestamp for ${event.name}`);
    if (event.atMs < previous) throw new Error(`timeline order regressed at ${event.name}`);
    previous = event.atMs;
  }
  const start = timeline.events.find((event) => event.name === "request_start")?.atMs ?? timeline.events[0].atMs;
  const end = timeline.events.find((event) => event.name === "complete")?.atMs ?? timeline.events[timeline.events.length - 1].atMs;
  if (end < start) throw new Error("timeline completion precedes start");
  return { valid: true, durationMs: end - start };
}

export function summarizeRequestTimeline(timelines: RequestTimeline[]): { count: number; completionP50Ms: number | null; completionP95Ms: number | null } {
  const durations = timelines.map((timeline) => validateRequestTimeline(timeline).durationMs);
  return { count: timelines.length, completionP50Ms: percentile(durations, 50), completionP95Ms: percentile(durations, 95) };
}
