"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { isErrorResponseBody } from "@/lib/api-response";
import { normalizeSuggestionAnchor } from "@/lib/suggestion-anchor";
import { withSessionHeaders } from "@/lib/client-session-auth";
import type { TranscriptChunk } from "@/types/session";
import type { Suggestion, SuggestionBatch } from "@/types/suggestions";

export type SuggestionFeedback = "dismiss" | "down" | "pin";

interface UseSuggestionsArgs {
  transcriptChunks: TranscriptChunk[];
  isRecording: boolean;
  sessionId?: string | null;
}

interface SummarizeSuccessResponse { summary: string }
interface SuggestionsSuccessResponse { suggestions: Suggestion[] }

function isSummarizeSuccess(value: unknown): value is SummarizeSuccessResponse {
  return typeof value === "object" && value !== null && "summary" in value && typeof (value as SummarizeSuccessResponse).summary === "string";
}

function isSuggestionsSuccess(value: unknown): value is SuggestionsSuccessResponse {
  return typeof value === "object" && value !== null && "suggestions" in value && Array.isArray((value as SuggestionsSuccessResponse).suggestions) && (value as SuggestionsSuccessResponse).suggestions.length === 3;
}

function buildContextStrings(chunks: readonly TranscriptChunk[], recentChars: number, earlierChars: number): { recentText: string; earlierText: string } {
  const fullText = chunks.map((chunk) => chunk.text).join("\n");
  const recentText = fullText.slice(-recentChars);
  const earlierPart = fullText.slice(0, Math.max(0, fullText.length - recentText.length));
  return { recentText, earlierText: earlierPart.slice(-earlierChars) };
}

export default function useSuggestions({ transcriptChunks, isRecording, sessionId }: UseSuggestionsArgs): {
  batches: SuggestionBatch[];
  setBatches: (batches: SuggestionBatch[]) => void;
  isLoading: boolean;
  triggerRefresh: () => void;
  nextRefreshAt: number | null;
  dismissedIds: ReadonlySet<string>;
  pinnedIds: ReadonlySet<string>;
  recordFeedback: (suggestion: Suggestion, feedback: SuggestionFeedback) => void;
  error: string | null;
} {
  const [batches, setBatchState] = useState<SuggestionBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const batchesRef = useRef(batches);
  const transcriptRef = useRef(transcriptChunks);
  const isLoadingRef = useRef(false);
  const dismissedPreviewsRef = useRef<string[]>([]);

  useEffect(() => { batchesRef.current = batches; }, [batches]);
  useEffect(() => { transcriptRef.current = transcriptChunks; }, [transcriptChunks]);

  const setBatches = useCallback((next: SuggestionBatch[]): void => {
    const hydrated = next.map((batch) => ({
      ...batch,
      timestamp: new Date(batch.timestamp),
      suggestions: batch.suggestions.map((suggestion) => ({ ...suggestion, id: suggestion.id ?? crypto.randomUUID() })),
    }));
    setBatchState(hydrated);
  }, []);

  const runCycle = useCallback(async (): Promise<void> => {
    if (isLoadingRef.current || transcriptRef.current.length === 0) return;
    const settings = loadCueMindSettings();
    isLoadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const { recentText, earlierText } = buildContextStrings(transcriptRef.current, settings.recentContextChars, settings.earlierContextChars);
      let earlierSummary = "";
      if (earlierText) {
        const response = await fetch("/api/summarize", {
          method: "POST",
          headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
          body: JSON.stringify({ sessionId, earlierTranscript: earlierText, summarizationPrompt: settings.summarizationPrompt }),
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(isErrorResponseBody(payload) ? payload.error : "Summarization failed");
        if (!isSummarizeSuccess(payload)) throw new Error("Invalid summarization response");
        earlierSummary = payload.summary;
      }

      const latestPreviews = batchesRef.current[0]?.suggestions.map((suggestion) => suggestion.preview) ?? [];
      const previousSuggestions = [...latestPreviews, ...dismissedPreviewsRef.current.slice(-12)].join("\n");
      const response = await fetch("/api/suggestions", {
        method: "POST",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId, recentTranscript: recentText, earlierSummary, previousSuggestions, suggestionsPrompt: settings.suggestionsPrompt }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(isErrorResponseBody(payload) ? payload.error : "Suggestions failed");
      if (!isSuggestionsSuccess(payload)) throw new Error("Invalid suggestions response");

      // anchor 契约（批次三）：必填字符串，去空白后 >12 字截断保留前 12；
      // 空/缺失 → 该建议丢弃（宁缺毋滥），批次允许少于 3 条。
      const anchorValidated: Suggestion[] = [];
      for (const suggestion of payload.suggestions) {
        const anchor = normalizeSuggestionAnchor(suggestion.anchor);
        if (anchor === null) continue;
        anchorValidated.push({ ...suggestion, anchor });
      }

      const batch: SuggestionBatch = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        suggestions: anchorValidated.map((suggestion) => ({ ...suggestion, id: crypto.randomUUID() })),
      };
      setBatchState((previous) => [batch, ...previous]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Network error while fetching suggestions.");
    } finally {
      isLoadingRef.current = false;
      setIsLoading(false);
    }
  }, [sessionId]);

  const triggerRefresh = useCallback((): void => {
    const interval = loadCueMindSettings().suggestionRefreshSeconds * 1000;
    setNextRefreshAt(isRecording ? Date.now() + interval : null);
    void runCycle();
  }, [isRecording, runCycle]);

  const recordFeedback = useCallback((suggestion: Suggestion, feedback: SuggestionFeedback): void => {
    if (!suggestion.id) return;
    if (feedback === "pin") {
      setPinnedIds((previous) => {
        const next = new Set(previous);
        if (next.has(suggestion.id!)) next.delete(suggestion.id!); else next.add(suggestion.id!);
        return next;
      });
      return;
    }
    dismissedPreviewsRef.current = [...dismissedPreviewsRef.current, suggestion.preview];
    setDismissedIds((previous) => new Set(previous).add(suggestion.id!));
  }, []);

  useEffect(() => {
    if (!isRecording) {
      setNextRefreshAt(null);
      return;
    }
    const interval = loadCueMindSettings().suggestionRefreshSeconds * 1000;
    setNextRefreshAt(Date.now() + interval);
    const id = window.setInterval(() => {
      setNextRefreshAt(Date.now() + interval);
      void runCycle();
    }, interval);
    return () => window.clearInterval(id);
  }, [isRecording, runCycle]);

  const firstTranscriptRef = useRef(false);
  useEffect(() => {
    if (!isRecording) { firstTranscriptRef.current = false; return; }
    if (transcriptChunks.length > 0 && !firstTranscriptRef.current) {
      firstTranscriptRef.current = true;
      void runCycle();
    }
  }, [isRecording, runCycle, transcriptChunks.length]);

  return { batches, setBatches, isLoading, triggerRefresh, nextRefreshAt, dismissedIds, pinnedIds, recordFeedback, error };
}
