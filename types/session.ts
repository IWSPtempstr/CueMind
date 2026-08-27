import type { ChatMessage } from "@/types/chat";
import type { SuggestionBatch } from "@/types/suggestions";

export type AudioSource = "system" | "microphone" | "upload";

export interface LatencyTrace {
  captureStartedAt?: Date;
  captureEndedAt?: Date;
  asrStartedAt?: Date;
  asrEndedAt?: Date;
  keywordStartedAt?: Date;
  keywordEndedAt?: Date;
  searchStartedAt?: Date;
  searchEndedAt?: Date;
  cardStartedAt?: Date;
  cardEndedAt?: Date;
  renderedAt?: Date;
}

export interface TranscriptChunk {
  id: string;
  text: string;
  timestamp: Date;
  source?: AudioSource;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  latency?: LatencyTrace;
}

export interface MeetingReport {
  content: string;
  generatedAt: Date;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  transcriptChunks: TranscriptChunk[];
  suggestionBatches: SuggestionBatch[];
  chatMessages: ChatMessage[];
  meetingReport: MeetingReport | null;
}
