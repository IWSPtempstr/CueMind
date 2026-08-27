import { parseDesktopEvent, type DesktopEvent } from "@/lib/desktop-events";

export interface DemoTranscriptChunk {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  sentenceBoundary?: boolean;
}

export interface DemoCandidateWindowOptions {
  datasetVersion: string;
  mediaId: string;
  asrVersion: string;
  windowingVersion: string;
  minimumDurationMs: number;
  contextOverlapMs: number;
  maximumDurationMs: number;
}

export type DemoWindowCloseReason =
  | "pause"
  | "sentence_end"
  | "speaker_change"
  | "semantic_boundary"
  | "max_duration"
  | "end_of_input";

export interface DemoCandidateWindow {
  coreStartMs: number;
  coreEndMs: number;
  contextStartMs: number;
  contextEndMs: number;
  transcriptChunkIds: string[];
  windowCloseReason: DemoWindowCloseReason;
  candidateIdInputs: {
    datasetVersion: string;
    mediaId: string;
    coreStartMs: number;
    coreEndMs: number;
    asrVersion: string;
    windowingVersion: string;
  };
}

export function buildDemoCandidateWindows(
  chunks: DemoTranscriptChunk[],
  options: DemoCandidateWindowOptions,
): DemoCandidateWindow[] {
  const windows: DemoCandidateWindow[] = [];
  let current: DemoTranscriptChunk[] = [];

  const close = (reason: DemoWindowCloseReason): void => {
    if (current.length === 0) return;
    const coreStartMs = current[0].startMs;
    const coreEndMs = current[current.length - 1].endMs;
    windows.push({
      coreStartMs,
      coreEndMs,
      contextStartMs: Math.max(0, coreStartMs - options.contextOverlapMs),
      contextEndMs: coreEndMs,
      transcriptChunkIds: current.map((chunk) => chunk.id),
      windowCloseReason: reason,
      candidateIdInputs: {
        datasetVersion: options.datasetVersion,
        mediaId: options.mediaId,
        coreStartMs,
        coreEndMs,
        asrVersion: options.asrVersion,
        windowingVersion: options.windowingVersion,
      },
    });
    current = [];
  };

  for (const chunk of chunks) {
    if (
      current.length > 0 &&
      chunk.endMs - current[0].startMs > options.maximumDurationMs
    ) {
      close("max_duration");
    }

    current.push(chunk);
    if (
      chunk.sentenceBoundary === true &&
      chunk.endMs - current[0].startMs >= options.minimumDurationMs
    ) {
      close("sentence_end");
    }
  }

  close("end_of_input");
  return windows;
}

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
