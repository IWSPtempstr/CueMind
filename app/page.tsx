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
import useMediaUploader from "@/hooks/useMediaUploader";
import useMicRecorder from "@/hooks/useMicRecorder";
import useSuggestions from "@/hooks/useSuggestions";
import { isErrorResponseBody } from "@/lib/api-response";
import { exportSession } from "@/lib/export";
import { END_OF_MEETING_PROMPT } from "@/lib/prompts";
import { loadSessions, storeSession } from "@/lib/session-storage";
import { summarizeLatency } from "@/lib/telemetry";
import type { MeetingReport, SessionSnapshot } from "@/types/session";
import type { Suggestion } from "@/types/suggestions";

function sessionTitle(snapshot: Pick<SessionSnapshot, "createdAt" | "transcriptChunks">): string {
  const firstWords = snapshot.transcriptChunks[0]?.text.trim().slice(0, 44);
  return firstWords || `会议 · ${snapshot.createdAt.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
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
  const [createdAt, setCreatedAt] = useState(new Date());
  const [resumeCandidate, setResumeCandidate] = useState<SessionSnapshot | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const transcriptRef = useRef(recorder.transcriptChunks);
  useEffect(() => { transcriptRef.current = recorder.transcriptChunks; }, [recorder.transcriptChunks]);

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
    setResumeCandidate(null);
  }, [activeSessionId, hasContent]);

  const snapshot = useMemo<SessionSnapshot>(() => {
    const base = {
      id: activeSessionId ?? "unsaved-session",
      createdAt,
      updatedAt: new Date(),
      transcriptChunks: recorder.transcriptChunks,
      suggestionBatches: suggestions.batches,
      chatMessages: chat.messages,
      meetingReport,
    };
    return { ...base, title: sessionTitle(base) };
  }, [activeSessionId, chat.messages, createdAt, meetingReport, recorder.transcriptChunks, suggestions.batches]);

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

  const restoreSession = useCallback((session: SessionSnapshot): void => {
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks(session.transcriptChunks);
    suggestions.setBatches(session.suggestionBatches);
    chat.setMessages(session.chatMessages);
    setMeetingReport(session.meetingReport);
    setActiveSessionId(session.id);
    setCreatedAt(session.createdAt);
    setResumeCandidate(null);
  }, [chat, recorder, suggestions]);

  const newSession = useCallback((): void => {
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks([]);
    suggestions.setBatches([]);
    chat.setMessages([]);
    setMeetingReport(null);
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
  }, [recorder.isRecording, recorder.transcriptChunks, reportRequested]);

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
                {session.title}
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
