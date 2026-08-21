import { parseDesktopEvent, type DesktopEvent } from "@/lib/desktop-events";

export function parseReplayEvents(raw: string): DesktopEvent[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDesktopEvent)
    .filter((event): event is DesktopEvent => event !== null);
}

export function replayDelayMs(
  previous: DesktopEvent | undefined,
  current: DesktopEvent,
  speed: number,
): number {
  if (!previous || speed <= 0) return 0;
  const previousTime = eventTime(previous);
  const currentTime = eventTime(current);
  if (previousTime === null || currentTime === null) return 0;
  return Math.max(0, Math.min(30_000, (currentTime - previousTime) / speed));
}

function eventTime(event: DesktopEvent): number | null {
  if (event.type === "audio_chunk_ready") return Date.parse(event.startedAt);
  if (event.type === "transcript_ready") return Date.parse(event.timestamp);
  return Date.parse(event.occurredAt);
}
