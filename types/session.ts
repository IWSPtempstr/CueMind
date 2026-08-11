import type { ChatMessage } from "@/types/chat";
import type { SuggestionBatch } from "@/types/suggestions";

export interface TranscriptChunk {
  id: string;
  text: string;
  timestamp: Date;
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
