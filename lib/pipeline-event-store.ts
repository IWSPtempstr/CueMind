import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import {
  createPipelineEvent,
  type PipelineEvent,
  type RequestTimelineEventName,
} from "@/lib/request-timeline";

const DEFAULT_EVENT_FILE = path.join(process.cwd(), "reports", "performance-resilience", "native-events.jsonl");
// Security plan §6.4: keep the timeline sink bounded. Per-event: runId length,
// metadata serialized size, and whole-event serialized size are capped at parse
// time. Cumulative: the JSONL file rotates (.<n> suffix, single previous
// generation kept) once it exceeds the ceiling, so per-session appends can
// never grow an unbounded artifact.
const MAX_RUN_ID_CHARS = 160;
const MAX_EVENT_METADATA_CHARS = 2_048;
const MAX_EVENT_SERIALIZED_CHARS = 4_096;
const MAX_EVENTS_FILE_BYTES = 16 * 1024 * 1024;

export function appendPipelineEvents(events: PipelineEvent[], file = process.env.CUEMIND_PIPELINE_EVENTS_FILE ?? DEFAULT_EVENT_FILE): void {
  if (events.length === 0) return;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (statSync(file).size > MAX_EVENTS_FILE_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // Missing file or failed rotation both fall through to the append attempt;
    // a failed rename leaves appendFileSync to surface a real write error.
  }
  appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
}

export function parsePipelineEvents(value: unknown): PipelineEvent[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const parsed: PipelineEvent[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.runId !== "string" || record.runId.length === 0 || record.runId.length > MAX_RUN_ID_CHARS) return null;
    if (typeof record.name !== "string" || typeof record.atMs !== "number") return null;
    if (record.metadata !== undefined && JSON.stringify(record.metadata ?? null).length > MAX_EVENT_METADATA_CHARS) return null;
    try {
      const event = createPipelineEvent(record.runId, record.name as RequestTimelineEventName, record.atMs, record.metadata);
      if (JSON.stringify(event).length > MAX_EVENT_SERIALIZED_CHARS) return null;
      const previous = parsed[parsed.length - 1];
      if (previous && (previous.runId !== event.runId || event.atMs < previous.atMs || parsed.some((item) => item.name === event.name))) return null;
      parsed.push(event);
    } catch {
      return null;
    }
  }
  return parsed;
}
