"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { LatencySample } from "@/lib/telemetry";
import type { TranscriptChunk } from "@/types/session";
import type { ContextCard, ContextCardFailure } from "@/types/suggestions";
import { appendPipelineEvent, createPipelineEvent, persistPipelineEvent, type PipelineEvent } from "@/lib/request-timeline";

type ContextCardTrace = NonNullable<ContextCard["demoTrace"]> & {
  finalState: NonNullable<ContextCard["demoTrace"]>["finalState"] | "suppressed_as_duplicate";
  duplicateOfCandidateId?: string;
};

type ContextCardResponse =
  | { card: ContextCard; failure?: never; trace?: { runId?: string; pipelineEvents?: PipelineEvent[] } }
  | { card: null; failure: { reason: string }; trace?: { runId?: string; pipelineEvents?: PipelineEvent[] } };

type ContextCardFailureWithTrace = ContextCardFailure & {
  demoTrace?: ContextCardTrace;
};

interface UseContextCardsArgs {
  transcriptChunks: TranscriptChunk[];
  isRecording: boolean;
  /** M2-a：候选账本归属会话；可空（服务端缺失时记 "unassigned"）。 */
  sessionId?: string | null;
}

export default function useContextCards({ transcriptChunks, isRecording, sessionId }: UseContextCardsArgs): {
  cards: ContextCard[];
  failures: ContextCardFailure[];
  isLoading: boolean;
  error: string | null;
  setCards: (cards: ContextCard[]) => void;
  latencySamples: LatencySample[];
  pipelineEvents: PipelineEvent[];
} {
  const [cards, setCardState] = useState<ContextCard[]>([]);
  const [failures, setFailures] = useState<ContextCardFailureWithTrace[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);
  const lastProcessedIdsRef = useRef<Set<string>>(new Set());
  const lastRunAtRef = useRef(0);
  const runningRef = useRef(false);
  const cardsRef = useRef(cards);
  const pendingRenderRunIdRef = useRef<string | null>(null);
  const pipelineEventsRef = useRef<PipelineEvent[]>([]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);

  const setCards = useCallback((next: ContextCard[]): void => {
    setCardState(next.map((card) => ({ ...card, createdAt: new Date(card.createdAt) })));
  }, []);

  const emitPipelineEvent = useCallback((runId: string, name: PipelineEvent["name"], metadata?: unknown): void => {
    try {
      const event = createPipelineEvent(runId, name, typeof performance !== "undefined" ? performance.now() : Date.now(), metadata);
      const eventsForRun = pipelineEventsRef.current.filter((item) => item.runId === runId);
      appendPipelineEvent(eventsForRun, event);
      persistPipelineEvent(event);
      pipelineEventsRef.current = [...pipelineEventsRef.current.filter((item) => item.runId !== runId), ...eventsForRun];
      setPipelineEvents([...pipelineEventsRef.current]);
    } catch {
      // Telemetry is best effort and must not affect card delivery.
    }
  }, []);

  const run = useCallback(async (chunks: TranscriptChunk[]): Promise<void> => {
    if (runningRef.current || chunks.length === 0) return;
    const settings = loadCueMindSettings();
    const now = Date.now();
    if (now - lastRunAtRef.current < settings.contextCardCooldownSeconds * 1000) return;
    runningRef.current = true;
    lastRunAtRef.current = now;
    const runId = chunks.find((chunk) => chunk.pipelineRunId)?.pipelineRunId ?? crypto.randomUUID();
    setIsLoading(true);
    const knownKeywords = cardsRef.current.map((card) => card.keyword);
    const knownCandidates = cardsRef.current.map(({ candidateId, keyword }) => ({ candidateId, keyword }));
    try {
      const response = await fetch("/api/context-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(sessionId ? { sessionId } : {}),
          runId,
          recentTranscript: chunks.slice(-8).map((chunk) => chunk.text).join("\n"),
          knownKeywords,
          knownCandidates,
          transcriptChunkIds: chunks.slice(-8).map((chunk) => chunk.id),
          settings: {
            modelProvider: settings.modelProvider,
            llamaCppBaseUrl: settings.llamaCppBaseUrl,
            llamaCppModel: settings.llamaCppModel,
            llamaCppApiKey: settings.llamaCppApiKey,
            remoteApiBaseUrl: settings.remoteApiBaseUrl,
            remoteApiModel: settings.remoteApiModel,
            remoteApiApiKey: settings.remoteApiApiKey,
            searchProvider: settings.searchProvider,
            searchApiKey: settings.searchApiKey,
            enableAgentReachFallback: settings.enableAgentReachFallback,
          },
        }),
      });
      const payload: unknown = await response.json();
      if (!isContextCardResponse(payload)) throw new Error("Invalid context card response");
      if (payload.card) {
        const card = hydrateCard(payload.card);
        pendingRenderRunIdRef.current = payload.trace?.runId ?? runId;
        emitPipelineEvent(pendingRenderRunIdRef.current, "render_start", { status: "commit" });
        setCardState((previous) => [card, ...previous]);
        setLatencySamples((previous) => [
          ...previous,
          ...([
            ["keyword", card.latencyMs.keyword],
            ["search", card.latencyMs.search],
            ["generation", card.latencyMs.generation],
            ["total", card.latencyMs.total],
          ] as const).map(([stage, durationMs]) => ({
            id: crypto.randomUUID(),
            stage,
            durationMs,
            createdAt: new Date(),
          })),
        ]);
      } else if (payload.failure) {
        setFailures((previous) => [{
          id: crypto.randomUUID(),
          keyword: "未识别",
          reason: payload.failure.reason,
          failedAt: new Date(),
          transcriptChunkIds: chunks.slice(-8).map((chunk) => chunk.id),
          demoTrace: payload.trace as ContextCardTrace | undefined,
        }, ...previous]);
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Context card request failed");
    } finally {
      runningRef.current = false;
      setIsLoading(false);
    }
  }, [emitPipelineEvent, sessionId]);

  // useLayoutEffect runs after React commits the card DOM. This is a DOM-commit
  // boundary, not an OS compositor/paint completion signal.
  useLayoutEffect(() => {
    const runId = pendingRenderRunIdRef.current;
    if (!runId) return;
    pendingRenderRunIdRef.current = null;
    emitPipelineEvent(runId, "render_end", { status: "committed" });
  }, [cards, emitPipelineEvent]);

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

  return { cards, failures, isLoading, error, setCards, latencySamples, pipelineEvents };
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
