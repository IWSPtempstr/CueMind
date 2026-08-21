"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { TranscriptChunk } from "@/types/session";
import type { ContextCard, ContextCardFailure } from "@/types/suggestions";

type ContextCardResponse =
  | { card: ContextCard; failure?: never }
  | { card: null; failure: { reason: string } };

interface UseContextCardsArgs {
  transcriptChunks: TranscriptChunk[];
  isRecording: boolean;
}

export default function useContextCards({ transcriptChunks, isRecording }: UseContextCardsArgs): {
  cards: ContextCard[];
  failures: ContextCardFailure[];
  isLoading: boolean;
  error: string | null;
  setCards: (cards: ContextCard[]) => void;
} {
  const [cards, setCardState] = useState<ContextCard[]>([]);
  const [failures, setFailures] = useState<ContextCardFailure[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastProcessedIdsRef = useRef<Set<string>>(new Set());
  const lastRunAtRef = useRef(0);
  const runningRef = useRef(false);
  const cardsRef = useRef(cards);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  const setCards = useCallback((next: ContextCard[]): void => {
    setCardState(next.map((card) => ({ ...card, createdAt: new Date(card.createdAt) })));
  }, []);

  const run = useCallback(async (chunks: TranscriptChunk[]): Promise<void> => {
    if (runningRef.current || chunks.length === 0) return;
    const settings = loadCueMindSettings();
    const now = Date.now();
    if (now - lastRunAtRef.current < settings.contextCardCooldownSeconds * 1000) return;
    runningRef.current = true;
    lastRunAtRef.current = now;
    setIsLoading(true);
    const knownKeywords = cardsRef.current.map((card) => card.keyword);
    try {
      const response = await fetch("/api/context-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recentTranscript: chunks.slice(-8).map((chunk) => chunk.text).join("\n"),
          knownKeywords,
          transcriptChunkIds: chunks.slice(-8).map((chunk) => chunk.id),
          settings: {
            ollamaBaseUrl: settings.ollamaBaseUrl,
            ollamaModel: settings.ollamaModel,
            searchProvider: settings.searchProvider,
            searchApiKey: settings.searchApiKey,
          },
        }),
      });
      const payload: unknown = await response.json();
      if (!isContextCardResponse(payload)) throw new Error("Invalid context card response");
      if (payload.card) {
        setCardState((previous) => [hydrateCard(payload.card), ...previous]);
      } else if (payload.failure) {
        setFailures((previous) => [{
          id: crypto.randomUUID(),
          keyword: "未识别",
          reason: payload.failure.reason,
          failedAt: new Date(),
          transcriptChunkIds: chunks.slice(-8).map((chunk) => chunk.id),
        }, ...previous]);
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Context card request failed");
    } finally {
      runningRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const newChunks = transcriptChunks.filter((chunk) => !lastProcessedIdsRef.current.has(chunk.id));
    if (newChunks.length === 0) return;
    for (const chunk of newChunks) lastProcessedIdsRef.current.add(chunk.id);
    void run(newChunks);
  }, [isRecording, run, transcriptChunks]);

  useEffect(() => {
    if (!isRecording) {
      lastProcessedIdsRef.current.clear();
      lastRunAtRef.current = 0;
    }
  }, [isRecording]);

  return { cards, failures, isLoading, error, setCards };
}

function hydrateCard(card: ContextCard): ContextCard {
  return { ...card, createdAt: new Date(card.createdAt) };
}

function isContextCardResponse(value: unknown): value is ContextCardResponse {
  if (typeof value !== "object" || value === null || !("card" in value)) return false;
  const card = (value as { card: unknown }).card;
  if (card === null) {
    return "failure" in value &&
      typeof (value as { failure?: unknown }).failure === "object" &&
      (value as { failure: { reason?: unknown } }).failure !== null &&
      typeof (value as { failure: { reason?: unknown } }).failure.reason === "string";
  }
  return typeof card === "object" && card !== null;
}
