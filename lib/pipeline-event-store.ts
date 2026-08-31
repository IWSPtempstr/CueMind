import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  createPipelineEvent,
  type PipelineEvent,
  type RequestTimelineEventName,
} from "@/lib/request-timeline";

const DEFAULT_EVENT_FILE = path.join(process.cwd(), "reports", "performance-resilience", "native-events.jsonl");

export function appendPipelineEvents(events: PipelineEvent[], file = process.env.CUEMIND_PIPELINE_EVENTS_FILE ?? DEFAULT_EVENT_FILE): void {
  if (events.length === 0) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
}

export function parsePipelineEvents(value: unknown): PipelineEvent[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const parsed: PipelineEvent[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (typeof record.runId !== "string" || typeof record.name !== "string" || typeof record.atMs !== "number") return null;
    try {
      const event = createPipelineEvent(record.runId, record.name as RequestTimelineEventName, record.atMs, record.metadata);
      const previous = parsed[parsed.length - 1];
      if (previous && (previous.runId !== event.runId || event.atMs < previous.atMs || parsed.some((item) => item.name === event.name))) return null;
      parsed.push(event);
    } catch {
      return null;
    }
  }
  return parsed;
}
