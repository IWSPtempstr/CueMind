"use client";

// Manages chat messages, local llama-server SSE streaming via /api/chat, and bridging suggestion preview/detail into the thread.

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { isErrorResponseBody } from "@/lib/api-response";
import { CHAT_HISTORY_MAX_MESSAGES } from "@/lib/prompts";
import type { TranscriptChunk } from "@/types/session";
import type { ChatMessage } from "@/types/chat";
import type { Suggestion } from "@/types/suggestions";

interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

function toApiHistory(messages: readonly ChatMessage[]): ChatHistoryEntry[] {
  return messages
    .filter((message) => !message.isStreaming && !message.isDetail)
    .map((message) => ({ role: message.role, content: message.content }))
    .slice(-CHAT_HISTORY_MAX_MESSAGES);
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

export default function useChat({
  transcriptChunks,
}: {
  transcriptChunks: TranscriptChunk[];
}): {
  messages: ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  isStreaming: boolean;
  sendMessage: (
    message: string,
    options?: { skipUserMessage?: boolean },
  ) => Promise<void>;
  addSuggestionToChat: (suggestion: Suggestion) => void;
  stopGenerating: () => void;
  retryLastFailed: () => void;
  canRetry: boolean;
  error: string | null;
} {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesRef = useRef<ChatMessage[]>(messages);
  const transcriptChunksRef = useRef<TranscriptChunk[]>(transcriptChunks);
  const isStreamingRef = useRef(false);
  const pendingHistoryForSkipRef = useRef<ChatHistoryEntry[] | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    transcriptChunksRef.current = transcriptChunks;
  }, [transcriptChunks]);

  const setMessagesFromSession = useCallback((next: ChatMessage[]): void => {
    setMessages(next.map((message) => ({ ...message, timestamp: new Date(message.timestamp), isStreaming: false })));
  }, []);

  const removeMessageById = useCallback((messageId: string): void => {
    setMessages((previous) => previous.filter((m) => m.id !== messageId));
  }, []);

  const appendToAssistant = useCallback(
    (assistantId: string, chunk: string): void => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content + chunk }
            : message,
        ),
      );
    },
    [],
  );

  const finishAssistantStream = useCallback((assistantId: string): void => {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === assistantId
          ? { ...message, isStreaming: false }
          : message,
      ),
    );
  }, []);

  const readSseStream = useCallback(
    async (body: ReadableStream<Uint8Array>, assistantId: string): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Groq streams SSE frames split across arbitrary chunks; buffer until event boundaries before parsing deltas.
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
          const json = JSON.parse(payload) as unknown;
          const piece = extractDeltaContent(json);
          if (piece !== null && piece.length > 0) {
            appendToAssistant(assistantId, piece);
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

      finishAssistantStream(assistantId);
    },
    [appendToAssistant, finishAssistantStream],
  );

  const sendMessage = useCallback(
    async (
      message: string,
      options?: { skipUserMessage?: boolean },
    ): Promise<void> => {
      if (isStreamingRef.current) {
        return;
      }

      if (typeof window === "undefined") {
        return;
      }

      const settings = loadCueMindSettings();

      const trimmed = message.trim();
      if (trimmed === "") {
        return;
      }

      setError(null);
      setLastFailedPrompt(null);

      const skipUserMessage = options?.skipUserMessage === true;
      const chatHistory = skipUserMessage
        ? (pendingHistoryForSkipRef.current ?? toApiHistory(messagesRef.current))
        : toApiHistory(messagesRef.current);
      pendingHistoryForSkipRef.current = null;

      const assistantId = crypto.randomUUID();

      if (!skipUserMessage) {
        const userId = crypto.randomUUID();
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
      } else {
        setMessages((previous) => [
          ...previous,
          {
            id: assistantId,
            role: "assistant",
            content: "",
            isStreaming: true,
            timestamp: new Date(),
          },
        ]);
      }

      isStreamingRef.current = true;
      setIsStreaming(true);

      const transcriptContext = transcriptChunksRef.current
        .map((chunk) => chunk.text)
        .join("\n")
        .slice(-settings.chatContextChars);

      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: trimmed,
            recentTranscript: transcriptContext,
            chatHistory,
            settings: {
              askPrompt: settings.askPrompt,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let messageText = "Chat request failed";
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
          return;
        }

        if (!response.body) {
          setError("No response body from chat");
          setLastFailedPrompt(trimmed);
          removeMessageById(assistantId);
          return;
        }

        await readSseStream(response.body, assistantId);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          finishAssistantStream(assistantId);
        } else {
          setError("Network error while chatting.");
          setLastFailedPrompt(trimmed);
          removeMessageById(assistantId);
        }
      } finally {
        abortControllerRef.current = null;
        isStreamingRef.current = false;
        setIsStreaming(false);
      }
    },
    [finishAssistantStream, readSseStream, removeMessageById],
  );

  const addSuggestionToChat = useCallback(
    (suggestion: Suggestion): void => {
      const historySnapshot = toApiHistory(messagesRef.current);
      pendingHistoryForSkipRef.current = historySnapshot;

      const userId = crypto.randomUUID();
      const detailId = crypto.randomUUID();

      setMessages((previous) => [
        ...previous,
        { id: userId, role: "user", content: suggestion.preview, timestamp: new Date() },
        {
          id: detailId,
          role: "assistant",
          content: suggestion.detail,
          isDetail: true,
          timestamp: new Date(),
        },
      ]);

      void sendMessage(suggestion.preview, { skipUserMessage: true });
    },
    [sendMessage],
  );

  const stopGenerating = useCallback((): void => {
    abortControllerRef.current?.abort();
  }, []);

  const retryLastFailed = useCallback((): void => {
    if (lastFailedPrompt && !isStreamingRef.current) void sendMessage(lastFailedPrompt);
  }, [lastFailedPrompt, sendMessage]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  return {
    messages,
    setMessages: setMessagesFromSession,
    isStreaming,
    sendMessage,
    addSuggestionToChat,
    stopGenerating,
    retryLastFailed,
    canRetry: lastFailedPrompt !== null,
    error,
  };
}
