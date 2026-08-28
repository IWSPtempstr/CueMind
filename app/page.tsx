"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import ChatPanel from "@/components/ChatPanel";
import ChatPanelDrawer from "@/components/ChatPanelDrawer";
import HealthPanel, { type AsrStatusSnapshot, type UploadStatusSnapshot } from "@/components/HealthPanel";
import LiveSuggestions from "@/components/LiveSuggestions";
import MediaUploadPanel from "@/components/MediaUploadPanel";
import MicTranscript from "@/components/MicTranscript";
import SettingsModal from "@/components/SettingsModal";
import useChat from "@/hooks/useChat";
import useContextCards from "@/hooks/useContextCards";
import useDesktopTranscript from "@/hooks/useDesktopTranscript";
import useMediaUploader, { isUploadedRecordCompleted } from "@/hooks/useMediaUploader";
import useMicRecorder from "@/hooks/useMicRecorder";
import useSuggestions from "@/hooks/useSuggestions";
import type { StoredChatMessage } from "@/lib/chat-store";
import { isErrorResponseBody } from "@/lib/api-response";
import { exportSession } from "@/lib/export";
import { END_OF_MEETING_PROMPT } from "@/lib/prompts";
import { loadSessions, storeSession } from "@/lib/session-storage";
import { summarizeLatency } from "@/lib/telemetry";
import type { ChatMessage } from "@/types/chat";
import type { MeetingReport, SessionSnapshot } from "@/types/session";
import type { Suggestion } from "@/types/suggestions";

function sessionTitle(snapshot: Pick<SessionSnapshot, "createdAt" | "transcriptChunks">): string {
  const firstWords = snapshot.transcriptChunks[0]?.text.trim().slice(0, 44);
  return firstWords || `会议 · ${snapshot.createdAt.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function formatSessionDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// --- P2 服务端 chat 持久化辅助：序列化 / 解析 / 合并 ---

function toStoredChatMessages(sessionId: string, messages: ChatMessage[]): StoredChatMessage[] {
  return messages
    .filter((message) => !message.isStreaming)
    .map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      content: message.content,
      isDetail: message.isDetail === true,
      createdAt: message.timestamp.toISOString(),
    }));
}

function parseStoredChatMessages(raw: unknown): StoredChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: StoredChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (typeof record.content !== "string") continue;
    if (typeof record.createdAt !== "string" || record.createdAt.length === 0) continue;
    messages.push({
      id: record.id,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
      role: record.role,
      content: record.content,
      isDetail: record.isDetail === true,
      createdAt: record.createdAt,
    });
  }
  return messages;
}

function mergeChatMessages(local: ChatMessage[], server: StoredChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of local) byId.set(message.id, message);
  // 服务端数据为准（同 id 覆盖本地），统一按 createdAt 升序。
  for (const message of server) {
    byId.set(message.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      isDetail: message.isDetail,
      timestamp: new Date(message.createdAt),
    });
  }
  return [...byId.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export default function Home(): ReactElement {
  const browserRecorder = useMicRecorder();
  const desktopRecorder = useDesktopTranscript();
  const recorder = desktopRecorder.isDesktop ? desktopRecorder : browserRecorder;
  const uploader = useMediaUploader({
    setTranscriptChunks: recorder.setTranscriptChunks,
    // 回调经 hook 内部 ref 每次渲染刷新，避免长任务读到过期闭包。
    getTranscriptChunks: () => recorder.transcriptChunks,
  });
  const isCardFlowActive = (recorder.isRecording && !recorder.isPaused) || uploader.isProcessing;
  const suggestions = useSuggestions({ transcriptChunks: recorder.transcriptChunks, isRecording: isCardFlowActive });
  const contextCards = useContextCards({ transcriptChunks: recorder.transcriptChunks, isRecording: isCardFlowActive });
  const chat = useChat({ transcriptChunks: recorder.transcriptChunks });
  const [pendingSuggestion, setPendingSuggestion] = useState<Suggestion | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [meetingReport, setMeetingReport] = useState<MeetingReport | null>(null);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [reportRequested, setReportRequested] = useState(false);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [topicSummary, setTopicSummary] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState(new Date());
  const [resumeCandidate, setResumeCandidate] = useState<SessionSnapshot | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const transcriptRef = useRef(recorder.transcriptChunks);
  useEffect(() => { transcriptRef.current = recorder.transcriptChunks; }, [recorder.transcriptChunks]);
  // 已处理过"上传完成"事件的 uploadId 去重集合（主题摘要只生成一次）。
  const handledUploadIdsRef = useRef(new Set<string>());
  // P2 chat 服务端同步：代 token 使在途合并失效（restore/new 切换会话时不串数据）。
  const chatSyncTokenRef = useRef(0);
  const wasChatOpenRef = useRef(false);

  const generateTopicSummary = useCallback((transcriptText: string): void => {
    const trimmed = transcriptText.trim();
    if (!trimmed) return;
    // fire-and-forget：失败静默，不影响主流程。
    void fetch("/api/session-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: trimmed }),
    }).then(async (response) => {
      if (!response.ok) return;
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("topic" in payload)) return;
      const topic = (payload as { topic: unknown }).topic;
      if (typeof topic === "string" && topic.trim().length > 0) setTopicSummary(topic.trim());
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const saved = loadSessions();
    setSessions(saved);
    setResumeCandidate(saved[0] ?? null);
  }, []);

  const hasContent = recorder.transcriptChunks.length > 0 || suggestions.batches.length > 0 || chat.messages.length > 0 || meetingReport !== null;
  useEffect(() => {
    if (!hasContent || activeSessionId) return;
    setActiveSessionId(crypto.randomUUID());
    setCreatedAt(new Date());
    setTopicSummary(null);
    setResumeCandidate(null);
  }, [activeSessionId, hasContent]);

  const snapshot = useMemo<SessionSnapshot>(() => {
    const base = {
      id: activeSessionId ?? "unsaved-session",
      createdAt,
      updatedAt: new Date(),
      transcriptChunks: recorder.transcriptChunks,
      suggestionBatches: suggestions.batches,
      // P2: chat 消息只持久化到服务端；保留字段以兼容旧 localStorage 快照的读取。
      chatMessages: [] as ChatMessage[],
      meetingReport,
    };
    return {
      ...base,
      title: topicSummary ?? sessionTitle(base),
      ...(topicSummary ? { topicSummary } : {}),
    };
  }, [activeSessionId, createdAt, meetingReport, recorder.transcriptChunks, suggestions.batches, topicSummary]);

  useEffect(() => {
    if (!activeSessionId || !hasContent) return;
    const id = window.setTimeout(() => {
      try {
        setSessions(storeSession({ ...snapshot, id: activeSessionId, updatedAt: new Date() }));
        setPersistenceError(null);
      } catch {
        setPersistenceError("Session autosave ran out of browser storage. Export this meeting to keep it safe.");
      }
    }, 700);
    return () => window.clearTimeout(id);
  }, [activeSessionId, hasContent, snapshot]);

  const postChatMessages = useCallback((sessionId: string, messages: ChatMessage[]): void => {
    const payload = toStoredChatMessages(sessionId, messages);
    if (payload.length === 0) return;
    // fire-and-forget：失败静默，不影响主流程。
    void fetch("/api/chat-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, messages: payload }),
    }).catch(() => undefined);
  }, []);

  const fetchServerChatMessages = useCallback(
    async (sessionId: string): Promise<StoredChatMessage[]> => {
      try {
        const response = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`);
        if (!response.ok) return [];
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("messages" in payload)) return [];
        return parseStoredChatMessages((payload as { messages: unknown }).messages);
      } catch {
        return [];
      }
    },
    [],
  );

  // P2: 消息落定后持久化到服务端——debounce 800ms；流式 delta 会持续重置计时器，
  // 因此流式中途不会触发 POST，仅在 isStreaming 结束后 800ms 落库。
  useEffect(() => {
    if (!activeSessionId || chat.messages.length === 0) return;
    if (chat.messages.some((message) => message.isStreaming)) return;
    const timer = window.setTimeout(() => {
      postChatMessages(activeSessionId, chat.messages);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, chat.messages, postChatMessages]);

  // P2: 抽屉打开（true 边沿）时按 activeSessionId 同步服务端历史——
  // 服务端无数据且内存有旧 localStorage 消息 → 懒迁移 POST；有数据 → 合并刷新。
  useEffect(() => {
    if (!isChatOpen) {
      wasChatOpenRef.current = false;
      return;
    }
    if (wasChatOpenRef.current) return;
    wasChatOpenRef.current = true;
    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const syncToken = chatSyncTokenRef.current;
    void fetchServerChatMessages(sessionId).then((serverMessages) => {
      if (chatSyncTokenRef.current !== syncToken) return;
      if (serverMessages.length === 0) {
        postChatMessages(sessionId, chat.messages);
        return;
      }
      chat.setMessages(mergeChatMessages(chat.messages, serverMessages));
    });
  }, [activeSessionId, chat, fetchServerChatMessages, isChatOpen, postChatMessages]);

  const restoreSession = useCallback((session: SessionSnapshot): void => {
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks(session.transcriptChunks);
    suggestions.setBatches(session.suggestionBatches);
    chat.setMessages(session.chatMessages);
    setMeetingReport(session.meetingReport);
    setTopicSummary(session.topicSummary ?? null);
    setActiveSessionId(session.id);
    setCreatedAt(session.createdAt);
    setResumeCandidate(null);
    // P2: localStorage 快照先行渲染，再异步拉服务端历史——有数据则以服务端为准合并（按 createdAt 排序）。
    const syncToken = ++chatSyncTokenRef.current;
    void fetchServerChatMessages(session.id).then((serverMessages) => {
      if (chatSyncTokenRef.current !== syncToken || serverMessages.length === 0) return;
      chat.setMessages(mergeChatMessages(session.chatMessages, serverMessages));
    });
  }, [chat, fetchServerChatMessages, recorder, suggestions]);

  const newSession = useCallback((): void => {
    chatSyncTokenRef.current += 1; // 使在途的服务端合并失效，避免旧会话消息混入新会话
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks([]);
    suggestions.setBatches([]);
    chat.setMessages([]);
    setMeetingReport(null);
    setTopicSummary(null);
    setActiveSessionId(crypto.randomUUID());
    setCreatedAt(new Date());
    setResumeCandidate(null);
  }, [chat, recorder, suggestions]);

  const handleRecordingChange = useCallback((recording: boolean): void => {
    if (recording) {
      setMeetingReport(null);
      void recorder.startRecording();
    } else {
      recorder.stopRecording();
      setReportRequested(true);
    }
  }, [recorder]);

  useEffect(() => {
    if (!reportRequested || recorder.isRecording || recorder.transcriptChunks.length === 0) return;
    const timer = window.setTimeout(() => {
      setReportRequested(false);
      setIsReportLoading(true);
      // 与会议总结并行生成会话主题摘要（fire-and-forget）。
      generateTopicSummary(transcriptRef.current.map((chunk) => chunk.text).join("\n"));
      void fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ earlierTranscript: transcriptRef.current.map((chunk) => chunk.text).join("\n"), summarizationPrompt: END_OF_MEETING_PROMPT }),
      }).then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(isErrorResponseBody(payload) ? payload.error : "Could not build the meeting report");
        if (typeof payload !== "object" || payload === null || !("summary" in payload) || typeof (payload as { summary: unknown }).summary !== "string") throw new Error("Invalid meeting report response");
        setMeetingReport({ content: (payload as { summary: string }).summary, generatedAt: new Date() });
      }).catch((caught: unknown) => setPersistenceError(caught instanceof Error ? caught.message : "Could not build the meeting report")).finally(() => setIsReportLoading(false));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [generateTopicSummary, recorder.isRecording, recorder.transcriptChunks, reportRequested]);

  // 触发点 2：上传完成（completed 记录按 uploadId 去重），转写内容足够时补生成主题摘要。
  useEffect(() => {
    const completedUnhandled = uploader.uploadedFiles.filter(
      (record) => isUploadedRecordCompleted(record) && !handledUploadIdsRef.current.has(record.uploadId),
    );
    if (completedUnhandled.length === 0) return;
    for (const record of completedUnhandled) handledUploadIdsRef.current.add(record.uploadId);
    if (recorder.transcriptChunks.length < 3 || topicSummary !== null) return;
    generateTopicSummary(recorder.transcriptChunks.map((chunk) => chunk.text).join("\n"));
  }, [generateTopicSummary, recorder.transcriptChunks, topicSummary, uploader.uploadedFiles]);

  const manualRefresh = useCallback((): void => {
    recorder.flushCurrentChunk();
    window.setTimeout(suggestions.triggerRefresh, 500);
  }, [recorder, suggestions.triggerRefresh]);

  const latencySamples = useMemo(
    () => [...desktopRecorder.latencySamples, ...contextCards.latencySamples],
    [contextCards.latencySamples, desktopRecorder.latencySamples],
  );
  const latencySummaries = useMemo(
    () => ([
      { stage: "asr", label: "ASR" },
      { stage: "keyword", label: "关键词" },
      { stage: "search", label: "检索" },
      { stage: "generation", label: "生成" },
      { stage: "total", label: "卡片总耗时" },
    ] as const).map(({ stage, label }) => ({ stage, label, ...summarizeLatency(latencySamples, stage) })),
    [latencySamples],
  );

  const asrStatus: AsrStatusSnapshot = {
    state: recorder.isPaused ? "paused" : recorder.isRecording ? "recording" : "idle",
    source: desktopRecorder.isDesktop ? "系统音频(桌面)" : "浏览器麦克风",
    retryCount: recorder.retryCount,
    error: recorder.error,
  };
  const uploadStatus: UploadStatusSnapshot | null = uploader.isProcessing
    ? {
        processing: true,
        fileName: uploader.processingFileName,
        progressPercent: uploader.progress,
        windows: uploader.transcribeProgress
          ? { received: uploader.transcribeProgress.received, total: uploader.transcribeProgress.total }
          : null,
      }
    : null;

  return (
    <div className="flex h-dvh min-h-0 w-full flex-col bg-[#0a0a0a] text-neutral-200">
      <header className="flex min-h-12 w-full flex-wrap items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-4 py-1">
        <span className="truncate text-sm font-medium uppercase tracking-widest text-neutral-400">CueMind 实时会议提示</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select
            aria-label="Saved sessions"
            value=""
            onChange={(event) => {
              const chosen = sessions.find((session) => session.id === event.target.value);
              if (chosen) restoreSession(chosen);
            }}
            className="max-w-40 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-400"
          >
            <option value="">会话（{sessions.length}）</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {formatSessionDate(session.createdAt)} - {session.topicSummary || session.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={newSession} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400">
            新建
          </button>
          <button type="button" disabled={!hasContent} onClick={() => exportSession(snapshot, "json")} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 disabled:opacity-40">
            JSON
          </button>
          <button type="button" disabled={!hasContent} onClick={() => exportSession(snapshot, "md")} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 disabled:opacity-40">
            Markdown
          </button>
          <button
            type="button"
            onClick={() => setIsChatOpen(true)}
            className="relative rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            会后追问
            {chat.messages.length > 0 ? (
              <span className="absolute -right-2 -top-2 flex min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-4 text-white">
                {chat.messages.length > 99 ? "99+" : chat.messages.length}
              </span>
            ) : null}
          </button>
          <button type="button" onClick={() => setIsSettingsOpen(true)} className="flex size-8 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400" aria-label="Open settings">
            ⚙
          </button>
        </div>
      </header>
      {resumeCandidate ? (
        <div className="flex items-center justify-center gap-3 border-b border-blue-900 bg-blue-950/30 px-4 py-2 text-xs text-blue-200">
          <span>Last meeting is waiting: “{resumeCandidate.title}”</span>
          <button type="button" onClick={() => restoreSession(resumeCandidate)} className="rounded bg-blue-600 px-2 py-1 text-white">
            恢复
          </button>
          <button type="button" onClick={() => setResumeCandidate(null)} className="text-blue-400">
            暂不恢复
          </button>
        </div>
      ) : null}
      {persistenceError ? (
        <div className="border-b border-red-900 bg-red-950/30 px-4 py-2 text-center text-xs text-red-300">
          {persistenceError}
        </div>
      ) : null}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col lg:flex-row [&>section]:min-w-0">
        <MicTranscript
          transcriptChunks={recorder.transcriptChunks}
          isRecording={recorder.isRecording}
          isPaused={recorder.isPaused}
          micLevel={recorder.micLevel}
          retryCount={recorder.retryCount}
          onRecordingChange={handleRecordingChange}
          onPauseToggle={recorder.isPaused ? recorder.resumeRecording : recorder.pauseRecording}
          recordingError={recorder.error}
          meetingReport={meetingReport}
          isReportLoading={isReportLoading}
          isUploadProcessing={uploader.isProcessing}
          uploaderSlot={
            <MediaUploadPanel
              isProcessing={uploader.isProcessing}
              progress={uploader.progress}
              transcribeProgress={uploader.transcribeProgress}
              processingFileName={uploader.processingFileName}
              uploadedFiles={uploader.uploadedFiles}
              error={uploader.error}
              onSelectFiles={uploader.handleFileList}
              onCancel={uploader.cancelUpload}
              onClearError={uploader.clearError}
            />
          }
        />
        <LiveSuggestions
          batches={suggestions.batches}
          isLoading={suggestions.isLoading}
          isRecording={recorder.isRecording && !recorder.isPaused}
          nextRefreshAt={suggestions.nextRefreshAt}
          onManualRefresh={manualRefresh}
          error={suggestions.error}
          onSuggestionSelect={(suggestion) => {
            setPendingSuggestion({ ...suggestion });
            setIsChatOpen(true);
          }}
          dismissedIds={suggestions.dismissedIds}
          pinnedIds={suggestions.pinnedIds}
          onFeedback={suggestions.recordFeedback}
          contextCards={contextCards.cards}
          contextCardFailures={contextCards.failures}
          contextCardsLoading={contextCards.isLoading}
          contextCardsError={contextCards.error}
        />
        <HealthPanel
          asrStatus={asrStatus}
          uploadStatus={uploadStatus}
          cardCount={contextCards.cards.length}
          failureCount={contextCards.failures.length}
          latestTotalLatencyMs={contextCards.cards[0]?.latencyMs.total ?? null}
          latencySummaries={latencySummaries}
          queueStatus={desktopRecorder.error?.includes("队列") ? "有待处理" : "正常"}
          degradationStatus={contextCards.cards.some((card) => card.demoTrace && card.demoTrace.decisionSource !== "model") ? "已启用" : null}
        />
      </main>
      <ChatPanelDrawer isOpen={isChatOpen} onClose={() => setIsChatOpen(false)}>
        <ChatPanel
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          sendMessage={chat.sendMessage}
          addSuggestionToChat={chat.addSuggestionToChat}
          error={chat.error}
          pendingSuggestion={pendingSuggestion}
          onSuggestionHandled={() => setPendingSuggestion(null)}
          stopGenerating={chat.stopGenerating}
          retryLastFailed={chat.retryLastFailed}
          canRetry={chat.canRetry}
        />
      </ChatPanelDrawer>
    </div>
  );
}
