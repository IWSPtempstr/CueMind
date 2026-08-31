import { percentile } from "@/lib/telemetry";

export const REQUEST_TIMELINE_EVENTS = [
  "request_start", "capture_start", "capture_end", "asr_start", "asr_end", "keyword_start", "keyword_end",
  "search_start", "search_end", "generation_start", "generation_end", "render_start", "render_end",
  "first_event", "first_token", "complete",
] as const;
export type RequestTimelineEventName = (typeof REQUEST_TIMELINE_EVENTS)[number];
export interface RequestTimelineEvent { name: RequestTimelineEventName; atMs: number }
export interface RequestTimeline { runId: string; status: string; events: RequestTimelineEvent[] }

export interface PipelineEventMetadata {
  source?: "microphone" | "system" | "upload";
  status?: string;
  reason?: string;
  errorCode?: string;
}

export interface PipelineEvent {
  runId: string;
  name: RequestTimelineEventName;
  atMs: number;
  metadata?: PipelineEventMetadata;
}

const PIPELINE_METADATA_KEYS = new Set<keyof PipelineEventMetadata>([
  "source",
  "status",
  "reason",
  "errorCode",
]);

/** Keep event metadata deliberately small and free of transcript/prompt/secrets. */
export function redactEventMetadata(value: unknown): PipelineEventMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const safe: PipelineEventMetadata = {};
  for (const key of PIPELINE_METADATA_KEYS) {
    const item = source[key];
    if (typeof item === "string" && item.trim().length > 0 && item.length <= 160) {
      const normalized = item.trim();
      if (key === "source") {
        if (normalized === "microphone" || normalized === "system" || normalized === "upload") safe.source = normalized;
      } else if (key === "status") safe.status = normalized;
      else if (key === "reason") safe.reason = normalized;
      else safe.errorCode = normalized;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function createPipelineEvent(
  runId: string,
  name: RequestTimelineEventName,
  atMs: number,
  metadata?: unknown,
): PipelineEvent {
  if (runId.trim().length === 0) throw new Error("pipeline event runId is required");
  if (!REQUEST_TIMELINE_EVENTS.includes(name)) throw new Error(`unknown pipeline event: ${name}`);
  if (!Number.isFinite(atMs) || atMs < 0) throw new Error(`invalid timestamp for ${name}`);
  const safeMetadata = redactEventMetadata(metadata);
  return {
    runId,
    name,
    atMs: Math.round(atMs),
    ...(safeMetadata ? { metadata: safeMetadata } : {}),
  };
}

/** Append in capture order; never sort away an ordering bug. */
export function appendPipelineEvent(events: PipelineEvent[], event: PipelineEvent): void {
  const previous = events[events.length - 1];
  if (previous && previous.runId !== event.runId) throw new Error("pipeline event runId mismatch");
  if (previous && event.atMs < previous.atMs) throw new Error(`pipeline event order regressed at ${event.name}`);
  if (events.some((item) => item.name === event.name)) throw new Error(`duplicate pipeline event: ${event.name}`);
  events.push(event);
}

/** Browser-side best-effort JSONL sink through the local API route. */
export function persistPipelineEvent(event: PipelineEvent): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  void window.fetch("/api/pipeline-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([event]),
    keepalive: true,
  }).catch(() => undefined);
}

export function createRequestTimeline(runId: string, events: RequestTimelineEvent[], status: string): RequestTimeline {
  const timeline = { runId, status, events: [...events] };
  validateRequestTimeline(timeline);
  return timeline;
}

export function validateRequestTimeline(timeline: RequestTimeline): { valid: true; durationMs: number } {
  if (!timeline || typeof timeline.runId !== "string" || timeline.runId.trim().length === 0) throw new Error("timeline runId is required");
  if (!Array.isArray(timeline.events) || timeline.events.length === 0) throw new Error("timeline events are required");
  let previous = -Infinity;
  const names = new Set<string>();
  for (const event of timeline.events) {
    if (!REQUEST_TIMELINE_EVENTS.includes(event.name)) throw new Error(`unknown timeline event: ${event.name}`);
    if (!Number.isFinite(event.atMs) || event.atMs < 0) throw new Error(`invalid timestamp for ${event.name}`);
    if (event.atMs < previous) throw new Error(`timeline order regressed at ${event.name}`);
    if (names.has(event.name)) throw new Error(`duplicate timeline event: ${event.name}`);
    names.add(event.name);
    previous = event.atMs;
  }
  const start = timeline.events.find((event) => event.name === "request_start")?.atMs ?? timeline.events[0].atMs;
  const end = timeline.events.find((event) => event.name === "complete")?.atMs ?? timeline.events[timeline.events.length - 1].atMs;
  if (end < start) throw new Error("timeline completion precedes start");
  return { valid: true, durationMs: end - start };
}

export function getStageDurations(timeline: RequestTimeline): {
  captureMs: number | null;
  asrMs: number | null;
  keywordMs: number | null;
  renderMs: number | null;
} {
  validateRequestTimeline(timeline);
  const duration = (start: RequestTimelineEventName, end: RequestTimelineEventName): number | null => {
    const started = timeline.events.find((event) => event.name === start)?.atMs;
    const finished = timeline.events.find((event) => event.name === end)?.atMs;
    return started === undefined || finished === undefined ? null : finished - started;
  };
  return {
    captureMs: duration("capture_start", "capture_end"),
    asrMs: duration("asr_start", "asr_end"),
    keywordMs: duration("keyword_start", "keyword_end"),
    renderMs: duration("render_start", "render_end"),
  };
}

export function summarizeRequestTimeline(timelines: RequestTimeline[]): { count: number; completionP50Ms: number | null; completionP95Ms: number | null } {
  const durations = timelines.map((timeline) => validateRequestTimeline(timeline).durationMs);
  return { count: timelines.length, completionP50Ms: percentile(durations, 50), completionP95Ms: percentile(durations, 95) };
}
