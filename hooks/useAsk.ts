"use client";

// Live-ask (会中询问) client hook: single-flight questions against /api/ask,
// SSE phase machine (keyword → searching → answer | degraded) and message
// solidification with traceable sources. Replaces the old follow-up chat hook.

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { isErrorResponseBody } from "@/lib/api-response";
import type { TranscriptChunk } from "@/types/session";
import type { AskSource, ChatMessage } from "@/types/chat";

export type AskPhase =
  | "idle"
  | "keyword"
  | "searching"
  | "answer"
  | "degraded"
  | "error";

export interface UseAskResult {
  messages: ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  phase: AskPhase;
  /** 单飞锁：有在途问题时禁止再次发送。 */
  busy: boolean;
  error: string | null;
  sendQuestion: (
    question: string,
    options?: { termHint?: string },
  ) => Promise<void>;
  stopGenerating: () => void;
  retryLastFailed: () => void;
  canRetry: boolean;
}

interface UseAskArgs {
  transcriptChunks: TranscriptChunk[];
  /** 会话归属（可选）：随请求透传，服务端仅用于日志/落库关联。 */
  sessionId?: string | null;
}

// 隐私红线：外发仅问题 + 提取关键词；最近转写只作为本地生成上下文。
const RECENT_TRANSCRIPT_CHUNKS = 8;

interface DegradedAttempts {
  vertical?: string[];
  genericFallback?: string;
  tries?: number;
  reason?: string;
}

function parseAskSources(value: unknown): AskSource[] {
  if (!Array.isArray(value)) return [];
  const sources: AskSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.url !== "string") continue;
    if (record.title.trim() === "" || record.url.trim() === "") continue;
    sources.push(
      typeof record.sourceType === "string" && record.sourceType !== ""
        ? { title: record.title, url: record.url, sourceType: record.sourceType }
        : { title: record.title, url: record.url },
    );
  }
  return sources;
}

function describeDegraded(message: string, attempts: DegradedAttempts): string {
  const tried: string[] = [];
  if (Array.isArray(attempts.vertical) && attempts.vertical.length > 0) {
    tried.push(attempts.vertical.join(" / "));
  }
  if (typeof attempts.genericFallback === "string" && attempts.genericFallback !== "") {
    tried.push(attempts.genericFallback);
  }
  const detail: string[] = [];
  if (typeof attempts.tries === "number" && attempts.tries > 0) {
    detail.push(`${attempts.tries} 次尝试`);
  }
  if (typeof attempts.reason === "string" && attempts.reason !== "") {
    detail.push(attempts.reason);
  }
  const suffix = tried.length > 0 ? `已尝试：${tried.join(" → ")}` : "已尝试本地垂直源与通用搜索";
  return `${message}\n${suffix}${detail.length > 0 ? `（${detail.join("，")}）` : ""}`;
}

function extractDeltaContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("choices" in data)) {
    return null;
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null || !("delta" in first)) {
    return null;
  }
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null || !("content" in delta)) {
    return null;
  }
  const content = (delta as { content: unknown }).content;
  if (content === null || content === undefined) {
    return null;
  }
  if (typeof content !== "string") {
    return null;
  }
  return content;
}

export default function useAsk({ transcriptChunks, sessionId }: UseAskArgs): UseAskResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [phase, setPhase] = useState<AskPhase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);

  const transcriptChunksRef = useRef<TranscriptChunk[]>(transcriptChunks);
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  const busyRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    transcriptChunksRef.current = transcriptChunks;
  }, [transcriptChunks]);

  useEffect(() => {
    sessionIdRef.current = sessionId ?? null;
  }, [sessionId]);

  const setMessagesFromSession = useCallback((next: ChatMessage[]): void => {
    setMessages(
      next.map((message) => ({
        ...message,
        timestamp: new Date(message.timestamp),
        isStreaming: false,
      })),
    );
  }, []);

  const removeMessageById = useCallback((messageId: string): void => {
    setMessages((previous) => previous.filter((m) => m.id !== messageId));
  }, []);

  const patchAssistant = useCallback(
    (assistantId: string, patch: (message: ChatMessage) => ChatMessage): void => {
      setMessages((previous) =>
        previous.map((message) => (message.id === assistantId ? patch(message) : message)),
      );
    },
    [],
  );

  const readSseStream = useCallback(
    async (body: ReadableStream<Uint8Array>, assistantId: string): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawAnswerChunk = false;

      // SSE frames can be split across arbitrary network chunks; buffer until
      // event boundaries (\n\n) before parsing (same semantics as old chat).
      const processLine = (rawLine: string): void => {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith("data:")) {
          return;
        }
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          return;
        }
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          const event = typeof data.event === "string" ? data.event : "";

          if (event === "searching") {
            setPhase("searching");
            return;
          }
          if (event === "answer_chunk") {
            if (!sawAnswerChunk) {
              sawAnswerChunk = true;
              setPhase("answer");
            }
            const piece = extractDeltaContent(data);
            if (piece !== null && piece.length > 0) {
              patchAssistant(assistantId, (message) => ({
                ...message,
                content: message.content + piece,
              }));
            }
            return;
          }
          if (event === "degraded") {
            setPhase("degraded");
            const messageText =
              typeof data.message === "string" && data.message !== ""
                ? data.message
                : "没找到可靠来源，无法给出有依据的回答。";
            const attempts =
              typeof data.attempts === "object" && data.attempts !== null
                ? (data.attempts as DegradedAttempts)
                : {};
            patchAssistant(assistantId, (message) => ({
              ...message,
              content: describeDegraded(messageText, attempts),
              isDegraded: true,
            }));
            return;
          }
          if (event === "done") {
            const finalState = typeof data.finalState === "string" ? data.finalState : "";
            const keywords = Array.isArray(data.keywords) ? data.keywords.filter((item): item is string => typeof item === "string") : [];
            if (finalState === "answered") {
              const sources = parseAskSources(data.sources);
              patchAssistant(assistantId, (message) => ({
                ...message,
                isStreaming: false,
                ...(sources.length > 0 ? { sources } : {}),
                ...(keywords.length > 0 ? { keywords } : {}),
                finalState,
              }));
              setPhase("idle");
            } else if (finalState === "degraded") {
              patchAssistant(assistantId, (message) => ({
                ...message,
                isStreaming: false,
                isDegraded: true,
                finalState,
                ...(keywords.length > 0 ? { keywords } : {}),
                content:
                  message.content !== ""
                    ? message.content
                    : "没找到可靠来源，无法给出有依据的回答。",
              }));
              setPhase("idle");
            } else {
              // invalid_schema / model_failed：fail-closed 终态，文案上屏可见。
              const failure =
                typeof data.failure === "object" && data.failure !== null
                  ? (data.failure as Record<string, unknown>)
                  : {};
              const reason =
                typeof failure.reason === "string" && failure.reason !== ""
                  ? failure.reason
                  : finalState === "invalid_schema"
                    ? "回答未通过结构校验"
                    : "本地模型生成失败";
              patchAssistant(assistantId, (message) => ({
                ...message,
                isStreaming: false,
                finalState,
                ...(keywords.length > 0 ? { keywords } : {}),
                content: `回答生成失败：${reason}${finalState === "invalid_schema" ? "（invalid_schema）" : ""}`,
              }));
              setError(reason);
              setPhase("error");
            }
            return;
          }
          // 兼容无 event 字段的纯 delta 帧（防御旧格式）。
          const piece = extractDeltaContent(data);
          if (piece !== null && piece.length > 0) {
            if (!sawAnswerChunk) {
              sawAnswerChunk = true;
              setPhase("answer");
            }
            patchAssistant(assistantId, (message) => ({
              ...message,
              content: message.content + piece,
            }));
          }
        } catch {
          /* ignore malformed SSE JSON */
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          for (const line of block.split("\n")) {
            processLine(line);
          }
          separatorIndex = buffer.indexOf("\n\n");
        }
      }

      for (const line of buffer.split("\n")) {
        processLine(line);
      }

      // 流结束兜底：未收到 done（连接中断）也要收尾，避免气泡卡在流式态。
      patchAssistant(assistantId, (message) =>
        message.isStreaming ? { ...message, isStreaming: false } : message,
      );
    },
    [patchAssistant],
  );

  const sendQuestion = useCallback(
    async (question: string, options?: { termHint?: string }): Promise<void> => {
      // 单飞锁：在途问题禁止再次发送。
      if (busyRef.current) {
        return;
      }
      if (typeof window === "undefined") {
        return;
      }
      const trimmed = question.trim();
      if (trimmed === "") {
        return;
      }

      const settings = loadCueMindSettings();
      setError(null);
      setLastFailedPrompt(null);

      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      setMessages((previous) => [
        ...previous,
        { id: userId, role: "user", content: trimmed, timestamp: new Date() },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          isStreaming: true,
          timestamp: new Date(),
        },
      ]);

      busyRef.current = true;
      setBusy(true);
      setPhase("keyword");

      // 最近 8 条转写只读拼接，仅作为本地生成上下文（绝不外发搜索层）。
      const recentTranscript = transcriptChunksRef.current
        .slice(-RECENT_TRANSCRIPT_CHUNKS)
        .map((chunk) => chunk.text)
        .join("\n");

      const termHint = options?.termHint?.trim() ?? "";
      const sessionIdValue = sessionIdRef.current;
      const runId = crypto.randomUUID();

      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId,
            question: trimmed,
            recentTranscript,
            ...(termHint !== "" ? { termHint } : {}),
            ...(sessionIdValue ? { sessionId: sessionIdValue } : {}),
            settings: {
              askPrompt: settings.askPrompt,
              searchApiKey: settings.searchApiKey,
              enableAgentReachFallback: settings.enableAgentReachFallback,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let messageText = "Ask request failed";
          try {
            const payload: unknown = await response.json();
            if (isErrorResponseBody(payload)) {
              messageText = payload.error;
            }
          } catch {
            /* use default */
          }
          setError(messageText);
          setLastFailedPrompt(trimmed);
          removeMessageById(assistantId);
          setPhase("error");
          return;
        }

        if (!response.body) {
          setError("No response body from ask");
          setLastFailedPrompt(trimmed);
          removeMessageById(assistantId);
          setPhase("error");
          return;
        }

        await readSseStream(response.body, assistantId);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          patchAssistant(assistantId, (message) => ({ ...message, isStreaming: false }));
          setPhase("idle");
        } else {
          setError("Network error while asking.");
          setLastFailedPrompt(trimmed);
          removeMessageById(assistantId);
          setPhase("error");
        }
      } finally {
        abortControllerRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [patchAssistant, readSseStream, removeMessageById],
  );

  const stopGenerating = useCallback((): void => {
    abortControllerRef.current?.abort();
  }, []);

  const retryLastFailed = useCallback((): void => {
    if (lastFailedPrompt && !busyRef.current) void sendQuestion(lastFailedPrompt);
  }, [lastFailedPrompt, sendQuestion]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  return {
    messages,
    setMessages: setMessagesFromSession,
    phase,
    busy,
    error,
    sendQuestion,
    stopGenerating,
    retryLastFailed,
    canRetry: lastFailedPrompt !== null,
  };
}
