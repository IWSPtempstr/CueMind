import type { TranscriptChunk } from "@/types/session";

export type TimelineKind = "transcript" | "card" | "ask" | "report";
export interface TimelineEntry { id: string; kind: TimelineKind; startMs?: number; endMs?: number; refId?: string; }
export interface Timeline { version: "timeline-v1"; entries: TimelineEntry[]; }

export function buildTimeline(args: {
  transcriptChunks: Pick<TranscriptChunk, "id" | "startMs" | "endMs">[];
  cards?: Array<{ candidateId: string; startMs?: number; endMs?: number }>;
  asks?: Array<{ id: string; startMs?: number; endMs?: number }>;
  report?: { id?: string; startMs?: number; endMs?: number };
}): Timeline {
  const entries: TimelineEntry[] = args.transcriptChunks.map((chunk) => ({ id: chunk.id, kind: "transcript", ...(typeof chunk.startMs === "number" ? { startMs: chunk.startMs } : {}), ...(typeof chunk.endMs === "number" ? { endMs: chunk.endMs } : {}) }));
  for (const card of args.cards ?? []) entries.push({ id: card.candidateId, kind: "card", ...(typeof card.startMs === "number" ? { startMs: card.startMs } : {}), ...(typeof card.endMs === "number" ? { endMs: card.endMs } : {}) });
  for (const ask of args.asks ?? []) entries.push({ id: ask.id, kind: "ask", ...(typeof ask.startMs === "number" ? { startMs: ask.startMs } : {}), ...(typeof ask.endMs === "number" ? { endMs: ask.endMs } : {}) });
  if (args.report) entries.push({ id: args.report.id ?? "meeting-report", kind: "report", ...(typeof args.report.startMs === "number" ? { startMs: args.report.startMs } : {}), ...(typeof args.report.endMs === "number" ? { endMs: args.report.endMs } : {}) });
  return { version: "timeline-v1", entries };
}
