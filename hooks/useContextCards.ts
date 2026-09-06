"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { LatencySample } from "@/lib/telemetry";
import type { TranscriptChunk } from "@/types/session";
import type { ContextCard, ContextCardFailure } from "@/types/suggestions";
import { appendPipelineEvent, createPipelineEvent, persistPipelineEvent, type PipelineEvent } from "@/lib/request-timeline";
import { buildCardContext } from "@/lib/realtime-context-memory";
import { withSessionHeaders } from "@/lib/client-session-auth";

type ContextCardTrace = NonNullable<ContextCard["demoTrace"]> & {
  finalState: NonNullable<ContextCard["demoTrace"]>["finalState"] | "suppressed_as_duplicate";
  duplicateOfCandidateId?: string;
};

type ContextCardResponse =
  | { card: ContextCard; failure?: never; trace?: { runId?: string; finalState?: string; pipelineEvents?: PipelineEvent[] } }
  | { card: null; failure: { reason: string }; trace?: { runId?: string; finalState?: string; pipelineEvents?: PipelineEvent[] } };

type ContextCardFailureWithTrace = ContextCardFailure & {
  demoTrace?: ContextCardTrace;
};

/** 失败横幅封顶：长会话中仅保留最近几条真实失败，避免列表无界增长（D10）。 */
const MAX_FAILURES = 5;
/** 失败条目按龄过期：超时未复发的条目自动淘汰，兜住“再无卡片运行”的长尾滞留。 */
const FAILURE_TTL_MS = 5 * 60_000;
const FAILURE_EXPIRY_POLL_MS = 30_000;
/** 连续非失败终态达到该次数即清零横幅（model_skip 等良性节流也是链路恢复的证据）。 */
const RECOVERY_BENIGN_RUNS = 2;
/** model_failed 客户端补一次重试的固定延迟：给槽位排队消化留出时间。 */
const MODEL_FAILURE_RETRY_DELAY_MS = 2_000;

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
  const pendingChunksRef = useRef<TranscriptChunk[]>([]);
  const lastRunAtRef = useRef(0);
  const runningRef = useRef(false);
  const transcriptChunksRef = useRef(transcriptChunks);
  const cardsRef = useRef(cards);
  const pendingRenderRunIdRef = useRef<string | null>(null);
  const pipelineEventsRef = useRef<PipelineEvent[]>([]);
  /** 连续非失败终态计数：达到 RECOVERY_BENIGN_RUNS 即清零失败横幅。 */
  const benignRunRef = useRef(0);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { transcriptChunksRef.current = transcriptChunks; }, [transcriptChunks]);

  const setCards = useCallback((next: ContextCard[]): void => {
    setCardState(next.map((card) => ({ ...card, createdAt: new Date(card.createdAt) })));
  }, []);

  const emitPipelineEvent = useCallback((runId: string, name: PipelineEvent["name"], metadata?: unknown): void => {
    try {
      const event = createPipelineEvent(runId, name, typeof performance !== "undefined" ? performance.now() : Date.now(), metadata);
      const eventsForRun = pipelineEventsRef.current.filter((item) => item.runId === runId);
      appendPipelineEvent(eventsForRun, event);
      persistPipelineEvent(event, sessionId);
      pipelineEventsRef.current = [...pipelineEventsRef.current.filter((item) => item.runId !== runId), ...eventsForRun];
      setPipelineEvents([...pipelineEventsRef.current]);
    } catch {
      // Telemetry is best effort and must not affect card delivery.
    }
  }, [sessionId]);

  const run = useCallback(async (chunks: TranscriptChunk[], opts?: { skipCooldown?: boolean; isRetry?: boolean }): Promise<void> => {
    if (runningRef.current || chunks.length === 0) return;
    const settings = loadCueMindSettings();
    const now = Date.now();
    const cooldownMs = settings.contextCardCooldownSeconds * 1000;
    const remainingCooldownMs = cooldownMs - (now - lastRunAtRef.current);
    // isRetry（model_failed 补一次）绕过冷却：失败已烧掉 12~27s 预算，
    // 再等整个冷却期会把“偶发慢一拍出卡”变成“下个窗口才出卡”。
    if (!opts?.skipCooldown && remainingCooldownMs > 0) {
      pendingChunksRef.current = [...chunks, ...pendingChunksRef.current].slice(-32);
      window.setTimeout(() => {
        if (runningRef.current || pendingChunksRef.current.length === 0) return;
        const pending = pendingChunksRef.current;
        pendingChunksRef.current = [];
        void run(pending);
      }, remainingCooldownMs);
      return;
    }
    runningRef.current = true;
    lastRunAtRef.current = now;
    const runId = chunks.find((chunk) => chunk.pipelineRunId)?.pipelineRunId ?? crypto.randomUUID();
    setIsLoading(true);
    const knownKeywords = cardsRef.current.map((card) => card.keyword);
    const cardContext = buildCardContext(transcriptChunksRef.current.map((chunk) => ({ id: chunk.id, text: chunk.text, timestampMs: chunk.timestamp.getTime() })), knownKeywords, [], []);
    const knownCandidates = cardsRef.current.map(({ candidateId, keyword }) => ({ candidateId, keyword }));
    try {
      const response = await fetch("/api/context-cards", {
        method: "POST",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          ...(sessionId ? { sessionId } : {}),
          runId,
          recentTranscript: chunks.slice(-8).map((chunk) => chunk.text).join("\n"),
          cardContext,
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
        // 成功清零（D5）：链路恢复即清除历史失败横幅，避免“失败：N 次”
        // 在后续全部成功后仍整个会话常驻。
        setFailures([]);
        benignRunRef.current = 0;
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
        // 终态分流：model_skip（泛化词/无新关键词）与 suppressed_as_duplicate
        // （关键词已有卡片）是运行期正常节流，不计入失败横幅，避免把
        // "失败：N 次" 误报给用户；仅真实失败（模型/检索/校验）计数。
        const finalState = payload.trace?.finalState;
        const benignSkip = finalState === "model_skip" || finalState === "suppressed_as_duplicate";
        if (!benignSkip) {
          benignRunRef.current = 0;
          setFailures((previous) => [{
            id: crypto.randomUUID(),
            keyword: "未识别",
            reason: payload.failure.reason,
            failedAt: new Date(),
            transcriptChunkIds: chunks.slice(-8).map((chunk) => chunk.id),
            demoTrace: payload.trace as ContextCardTrace | undefined,
          }, ...previous].slice(0, MAX_FAILURES));
          // model_failed 客户端补一次重试（服务端瞬态重试之外）：失败即无卡，
          // 重提不会产生重复卡片；isRetry 标记保证至多补一次，不成环。
          if (finalState === "model_failed" && !opts?.isRetry) {
            window.setTimeout(() => {
              if (runningRef.current) return;
              void run(chunks, { skipCooldown: true, isRetry: true });
            }, MODEL_FAILURE_RETRY_DELAY_MS);
          }
        } else {
          // 良性节流也是链路健康的证据：连续多次非失败终态即清零横幅，
          // 覆盖“失败后再无新卡（全是 model_skip）”导致横幅滞留的场景。
          benignRunRef.current += 1;
          if (benignRunRef.current >= RECOVERY_BENIGN_RUNS) {
            benignRunRef.current = 0;
            setFailures((previous) => previous.length > 0 ? [] : previous);
          }
        }
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Context card request failed");
      pendingChunksRef.current = [...chunks, ...pendingChunksRef.current].slice(-32);
    } finally {
      runningRef.current = false;
      setIsLoading(false);
      if (pendingChunksRef.current.length > 0) {
        const pending = pendingChunksRef.current;
        pendingChunksRef.current = [];
        window.setTimeout(() => { void run(pending); }, 0);
      }
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
    pendingChunksRef.current = [...pendingChunksRef.current, ...newChunks].slice(-32);
    for (const chunk of newChunks) lastProcessedIdsRef.current.add(chunk.id);
    if (runningRef.current) return;
    const pending = pendingChunksRef.current;
    pendingChunksRef.current = [];
    void run(pending);
  }, [isRecording, run, transcriptChunks]);

  useEffect(() => {
    if (!isRecording) {
      lastProcessedIdsRef.current.clear();
      pendingChunksRef.current = [];
      lastRunAtRef.current = 0;
      benignRunRef.current = 0;
      // 会话结束即清失败横幅：残余失败提示不应跨会话（跨录音段）滞留。
      setFailures((previous) => previous.length > 0 ? [] : previous);
    }
  }, [isRecording]);

  // 失败条目按龄过期：仅在有失败存在时低频轮询，超龄未复发的条目自动淘汰，
  // 兜住“录音继续但再无卡片运行”导致横幅整个会话滞留的长尾场景。
  useEffect(() => {
    if (failures.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setFailures((previous) => {
        const retained = previous.filter((failure) => now - failure.failedAt.getTime() < FAILURE_TTL_MS);
        return retained.length === previous.length ? previous : retained;
      });
    }, FAILURE_EXPIRY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [failures.length]);

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
