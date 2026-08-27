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
  sourceType?: "arxiv" | "hackernews" | "github" | "stackoverflow" | "web";
}

export interface ContextCardDemoTrace {
  candidateId: string;
  datasetVersion: string;
  windowingVersion: string;
  finalState: "card_shown" | "model_skip" | "search_failed" | "model_failed" | "invalid_schema" | "invalid_request";
  decisionSource: "hard_rule" | "model" | "search" | "system";
}

export interface ContextCard {
  id: string;
  candidateId: string;
  datasetVersion: string;
  windowingVersion: string;
  coreStartMs: number;
  coreEndMs: number;
  contextStartMs: number;
  contextEndMs: number;
  keyword: string;
  explanation: string;
  whyNow: string;
  sources: [ContextCardSource, ContextCardSource];
  createdAt: Date;
  transcriptChunkIds: string[];
  demoTrace?: ContextCardDemoTrace;
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
  demoTrace?: ContextCardDemoTrace;
}
