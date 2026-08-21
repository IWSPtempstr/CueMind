// Shared types for structured meeting suggestions, batches, and suggestion-type labels.

export type SuggestionType =
  | "question"
  | "talking_point"
  | "answer"
  | "fact_check"
  | "clarify";

export interface Suggestion {
  id?: string;
  type: SuggestionType;
  preview: string;
  detail: string;
}

export interface SuggestionBatch {
  id: string;
  timestamp: Date;
  suggestions: Suggestion[];
}

export interface ContextCardSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ContextCard {
  id: string;
  keyword: string;
  explanation: string;
  whyNow: string;
  sources: [ContextCardSource, ContextCardSource];
  createdAt: Date;
  transcriptChunkIds: string[];
  latencyMs: {
    keyword: number;
    search: number;
    generation: number;
    total: number;
  };
}

export interface ContextCardFailure {
  id: string;
  keyword: string;
  reason: string;
  failedAt: Date;
  transcriptChunkIds: string[];
}
