"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import AskPanel from "@/components/AskPanel";
import ContextCardsPanel from "@/components/ContextCardsPanel";
import { type AsrStatusSnapshot, type UploadStatusSnapshot } from "@/components/HealthPanel";
import MediaUploadPanel from "@/components/MediaUploadPanel";
import MicTranscript from "@/components/MicTranscript";
import SettingsModal from "@/components/SettingsModal";
import useAsk from "@/hooks/useAsk";
import useContextCards from "@/hooks/useContextCards";
import useDesktopTranscript from "@/hooks/useDesktopTranscript";
import useMediaUploader, { isUploadedRecordCompleted } from "@/hooks/useMediaUploader";
import useMicRecorder from "@/hooks/useMicRecorder";
import useSuggestions from "@/hooks/useSuggestions";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { StoredChatMessage } from "@/lib/chat-store";
import { isErrorResponseBody } from "@/lib/api-response";
import { generateClientSessionAccessToken, loadSessionAccessToken, storeSessionAccessToken, withSessionHeaders } from "@/lib/client-session-auth";
import { extractAskExchanges } from "@/lib/ask-history";
import { AUDIO_SOURCE_MODE_LABELS } from "@/lib/audio-source-mode";
import { exportSession } from "@/lib/export";
import { END_OF_MEETING_PROMPT } from "@/lib/prompts";
import { loadSessions, storeSession } from "@/lib/session-storage";
import { matchSuggestionAnchor } from "@/lib/suggestion-anchor";
import { summarizeLatency } from "@/lib/telemetry";
import type { ChatMessage } from "@/types/chat";
import type { MeetingReport, PostmeetingTranscriptArtifact, SessionSnapshot } from "@/types/session";
import type { ContextCard } from "@/types/suggestions";

function sessionTitle(snapshot: Pick<SessionSnapshot, "createdAt" | "transcriptChunks">): string {
  const firstWords = snapshot.transcriptChunks[0]?.text.trim().slice(0, 44);
  return firstWords || `会议 · ${snapshot.createdAt.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

// M3-a：卡片沉淀去重记录（本地持久化，避免重复导出同一 candidateId）。
const DEPOSITED_CARDS_STORAGE_KEY = "cuemind_deposited_cards";
const USEFUL_CARDS_STORAGE_KEY = "cuemind_useful_cards";

function loadDepositedCardIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DEPOSITED_CARDS_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function formatSessionDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// --- P2 服务端询问历史持久化辅助（语义升级：chat_messages 表承载会中询问）：序列化 / 解析 / 合并 ---

function toStoredAskMessages(sessionId: string, messages: ChatMessage[]): StoredChatMessage[] {
  return messages
    .filter((message) => !message.isStreaming)
    .map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      content: message.content,
      isDetail: message.isDetail === true,
      createdAt: message.timestamp.toISOString(),
      sources: message.sources,
      keywords: message.keywords,
      finalState: message.finalState,
    }));
}

function parseStoredAskMessages(raw: unknown): StoredChatMessage[] {
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
      sources: Array.isArray(record.sources) ? record.sources.filter((item): item is { title: string; url: string; sourceType?: string } => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).title === "string" && typeof (item as Record<string, unknown>).url === "string") : undefined,
      keywords: Array.isArray(record.keywords) ? record.keywords.filter((item): item is string => typeof item === "string") : undefined,
      finalState: typeof record.finalState === "string" ? record.finalState : undefined,
      createdAt: record.createdAt,
    });
  }
  return messages;
}

function mergeAskMessages(local: ChatMessage[], server: StoredChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of local) byId.set(message.id, message);
  // 服务端数据为准（同 id 覆盖本地），统一按 createdAt 升序。
  for (const message of server) {
    byId.set(message.id, {
      id: message.id,
      role: message.role,
      content: message.content,
      isDetail: message.isDetail,
      sources: message.sources,
      keywords: message.keywords,
      finalState: message.finalState,
      isDegraded: message.finalState === "degraded",
      timestamp: new Date(message.createdAt),
    });
  }
  return [...byId.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export default function Home(): ReactElement {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionTokenRef = useRef("");
  const browserRecorder = useMicRecorder(activeSessionId);
  const desktopRecorder = useDesktopTranscript(activeSessionId);
  const recorder = desktopRecorder.isDesktop ? desktopRecorder : browserRecorder;
  const uploader = useMediaUploader({
    sessionId: activeSessionId,
    setTranscriptChunks: recorder.setTranscriptChunks,
    // 回调经 hook 内部 ref 每次渲染刷新，避免长任务读到过期闭包。
    getTranscriptChunks: () => recorder.transcriptChunks,
  });
  const isCardFlowActive = (recorder.isRecording && !recorder.isPaused) || uploader.isProcessing;
  const suggestions = useSuggestions({ transcriptChunks: recorder.transcriptChunks, isRecording: isCardFlowActive, sessionId: activeSessionId });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [meetingReport, setMeetingReport] = useState<MeetingReport | null>(null);
  const [postmeetingTranscript, setPostmeetingTranscript] = useState<PostmeetingTranscriptArtifact | null>(null);
  const [isPostmeetingLoading, setIsPostmeetingLoading] = useState(false);
  const [isReportLoading, setIsReportLoading] = useState(false);
  const [reportRequested, setReportRequested] = useState(false);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  // 会中询问（决策 67/68）：单飞锁 + SSE 阶段状态机，请求体透传 sessionId。
  const ask = useAsk({ transcriptChunks: recorder.transcriptChunks, sessionId: activeSessionId });
  // 批次三：转写内联标注点击 → setAskDraft 预填右栏询问框（AskPanel 不自动发送）。
  const [askDraft, setAskDraft] = useState("");
  // B 阶段：卡片「问更多」→ setAskTermHint 预填右栏询问框并聚焦 + 提交透传 termHint。
  const [askTermHint, setAskTermHint] = useState("");
  const [topicSummary, setTopicSummary] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState(new Date());
  const [resumeCandidate, setResumeCandidate] = useState<SessionSnapshot | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  // M2-a：卡片请求透传 activeSessionId（账本归属）。activeSessionId 在上方声明后才能引用，
  // 故 useContextCards 置于 state 声明之后（hook 顺序跨渲染稳定即可）。
  const contextCards = useContextCards({ transcriptChunks: recorder.transcriptChunks, isRecording: isCardFlowActive, sessionId: activeSessionId });
  const transcriptRef = useRef(recorder.transcriptChunks);
  useEffect(() => { transcriptRef.current = recorder.transcriptChunks; }, [recorder.transcriptChunks]);
  // M3-a：导出链路用 ref 读取最新会话上下文（回调闭包不随渲染刷新也不会读到过期值）。
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  const topicSummaryRef = useRef(topicSummary);
  useEffect(() => { topicSummaryRef.current = topicSummary; }, [topicSummary]);
  const createdAtRef = useRef(createdAt);
  useEffect(() => { createdAtRef.current = createdAt; }, [createdAt]);
  const contextCardsRef = useRef(contextCards.cards);
  useEffect(() => { contextCardsRef.current = contextCards.cards; }, [contextCards.cards]);
  // M3-a：已沉淀卡片去重集合（localStorage cuemind_deposited_cards）。
  const [depositedCardIds, setDepositedCardIds] = useState<ReadonlySet<string>>(() => new Set());
  const [usefulCandidateIds, setUsefulCandidateIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setDepositedCardIds(loadDepositedCardIds()); }, []);
  // 已处理过"上传完成"事件的 uploadId 去重集合（主题摘要只生成一次）。
  const handledUploadIdsRef = useRef(new Set<string>());
  // P2 → live-ask 服务端同步：代 token 使在途合并失效（restore/new 切换会话时不串数据）；
  // lastAskSyncedSessionRef 保证每个 sessionId 只拉取一次历史（AskPanel 常驻右栏）。
  const askSyncTokenRef = useRef(0);
  const lastAskSyncedSessionRef = useRef<string | null>(null);
  // B 阶段：总结/导出复用会中询问问答对——ref 读取最新消息，避免长任务读到过期闭包。
  const askMessagesRef = useRef(ask.messages);
  useEffect(() => { askMessagesRef.current = ask.messages; }, [ask.messages]);

  const generateTopicSummary = useCallback((transcriptText: string): void => {
    const trimmed = transcriptText.trim();
    if (!trimmed) return;
    // fire-and-forget：失败静默，不影响主流程。
    void fetch("/api/session-title", {
      method: "POST",
      headers: withSessionHeaders(activeSessionIdRef.current, { "Content-Type": "application/json" }),
      body: JSON.stringify({ transcript: trimmed, sessionId: activeSessionIdRef.current }),
    }).then(async (response) => {
      if (!response.ok) return;
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("topic" in payload)) return;
      const topic = (payload as { topic: unknown }).topic;
      if (typeof topic === "string" && topic.trim().length > 0) setTopicSummary(topic.trim());
    }).catch(() => undefined);
  }, []);

  const polishPostmeetingTranscript = useCallback((): void => {
    const chunks = transcriptRef.current;
    if (chunks.length === 0 || isPostmeetingLoading) return;
    setIsPostmeetingLoading(true);
    void fetch("/api/postmeeting-transcript", {
      method: "POST",
      headers: withSessionHeaders(activeSessionIdRef.current, { "Content-Type": "application/json", "X-Session-Id": activeSessionIdRef.current ?? "" }),
      body: JSON.stringify({ sessionId: activeSessionIdRef.current, transcriptChunks: chunks.map((chunk) => ({ text: chunk.text })) }),
    }).then(async (response) => {
      const payload: unknown = await response.json();
      if (!response.ok || typeof payload !== "object" || payload === null || typeof (payload as { text?: unknown }).text !== "string") {
        throw new Error("无法整理会后转写");
      }
      const record = payload as Omit<PostmeetingTranscriptArtifact, "generatedAt"> & { generatedAt: string };
      setPostmeetingTranscript({ ...record, generatedAt: new Date(record.generatedAt) });
    }).catch((error: unknown) => setPersistenceError(error instanceof Error ? error.message : "无法整理会后转写"))
      .finally(() => setIsPostmeetingLoading(false));
  }, [isPostmeetingLoading]);

  // M3-a：会议总结生成成功后的旁路 vault 导出（fire-and-forget，失败静默）。
  // 门槛：meetingReport 非空且转写非空才导；meetings 落盘后不可变（幂等键 = snapshot.id）。
  const exportMeetingSnapshotToVault = useCallback((reportContent: string): void => {
    const chunks = transcriptRef.current;
    if (reportContent.trim().length === 0 || chunks.length === 0) return;
    const settings = loadCueMindSettings();
    void fetch("/api/vault-export", {
      method: "POST",
      headers: withSessionHeaders(activeSessionIdRef.current, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        sessionId: activeSessionIdRef.current,
        kind: "meeting",
        exportTranscript: settings.exportTranscript,
        vaultPath: settings.vaultPath,
        asrModel: settings.localWhisperModelPath,
        snapshot: {
          id: activeSessionIdRef.current ?? "unsaved-session",
          title: topicSummaryRef.current ?? sessionTitle({ createdAt: createdAtRef.current, transcriptChunks: chunks }),
          ...(topicSummaryRef.current ? { topicSummary: topicSummaryRef.current } : {}),
          createdAt: createdAtRef.current.toISOString(),
          transcriptChunks: chunks.map((chunk) => ({
            id: chunk.id,
            text: chunk.text,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            source: chunk.source,
          })),
          meetingReport: { content: reportContent },
        },
        cards: contextCardsRef.current.map((card) => ({ keyword: card.keyword, candidateId: card.candidateId })),
        asks: extractAskExchanges(askMessagesRef.current),
      }),
    }).catch(() => undefined);
  }, []);

  // M3-a：卡片「✨ 沉淀」→ 导出 cuemind/concepts/<term>.md（幂等键 = candidateId，
  // 服务端追加语义绝不覆盖）。fire-and-forget，不影响卡片链路。
  const handleCardDeposit = useCallback((card: ContextCard): void => {
    if (!card.candidateId || depositedCardIds.has(card.candidateId)) return;
    const next = new Set(depositedCardIds);
    next.add(card.candidateId);
    setDepositedCardIds(next);
    try {
      localStorage.setItem(DEPOSITED_CARDS_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // 存储溢出等：去重记录失败不影响本次导出。
    }
    const settings = loadCueMindSettings();
    void fetch("/api/vault-export", {
      method: "POST",
      headers: withSessionHeaders(activeSessionIdRef.current, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        kind: "concept",
        candidateId: card.candidateId,
        sessionId: activeSessionIdRef.current,
        vaultPath: settings.vaultPath,
        card: {
          id: card.id,
          candidateId: card.candidateId,
          keyword: card.keyword,
          keyPoints: card.keyPoints,
          explanation: card.explanation,
          sources: card.sources,
        },
      }),
    }).catch(() => undefined);
  }, [depositedCardIds]);

  const handleMarkUseful = useCallback((card: ContextCard): void => {
    if (!card.candidateId || usefulCandidateIds.has(card.candidateId)) return;
    const next = new Set(usefulCandidateIds).add(card.candidateId);
    setUsefulCandidateIds(next);
    try { localStorage.setItem(USEFUL_CARDS_STORAGE_KEY, JSON.stringify([...next])); } catch { /* local audit is best effort */ }
  }, [usefulCandidateIds]);

  useEffect(() => {
    const saved = loadSessions();
    setSessions(saved);
    setResumeCandidate(saved[0] ?? null);
  }, []);

  const hasContent = recorder.transcriptChunks.length > 0 || suggestions.batches.length > 0 || ask.messages.length > 0 || meetingReport !== null;
  useEffect(() => {
    activeSessionTokenRef.current = loadSessionAccessToken(activeSessionId);
  }, [activeSessionId]);
  useEffect(() => {
    if (activeSessionId) return;
    const sessionId = crypto.randomUUID();
    const sessionToken = generateClientSessionAccessToken();
    storeSessionAccessToken(sessionId, sessionToken);
    activeSessionTokenRef.current = sessionToken;
    setActiveSessionId(sessionId);
    setCreatedAt(new Date());
    setTopicSummary(null);
    setResumeCandidate(null);
  }, [activeSessionId]);

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
      postmeetingTranscript: postmeetingTranscript ?? undefined,
    };
    return {
      ...base,
      title: topicSummary ?? sessionTitle(base),
      ...(topicSummary ? { topicSummary } : {}),
    };
  }, [activeSessionId, createdAt, meetingReport, postmeetingTranscript, recorder.transcriptChunks, suggestions.batches, topicSummary]);

  useEffect(() => {
    if (!activeSessionId || !hasContent) return;
    const id = window.setTimeout(() => {
      try {
        const snapshotToSave = { ...snapshot, id: activeSessionId, updatedAt: new Date() };
        const serverSnapshot = { ...snapshotToSave };
        delete serverSnapshot.sessionAccessToken;
        setSessions(storeSession(snapshotToSave));
        setPersistenceError(null);
        // M1 服务端会话持久化：fire-and-forget，失败静默，绝不阻塞自动保存主流程。
        void fetch("/api/sessions", {
          method: "POST",
          headers: withSessionHeaders(activeSessionId, { "Content-Type": "application/json" }),
          body: JSON.stringify(serverSnapshot),
        }).then(async (response) => {
          if (!response.ok) return;
          const payload: unknown = await response.json();
          if (typeof payload === "object" && payload !== null && typeof (payload as { sessionAccessToken?: unknown }).sessionAccessToken === "string") {
            const token = (payload as { sessionAccessToken: string }).sessionAccessToken;
            storeSessionAccessToken(activeSessionId, token);
            activeSessionTokenRef.current = token;
          }
        }).catch(() => undefined);
      } catch {
        setPersistenceError("Session autosave ran out of browser storage. Export this meeting to keep it safe.");
      }
    }, 700);
    return () => window.clearTimeout(id);
  }, [activeSessionId, hasContent, snapshot]);

  const postAskMessages = useCallback((sessionId: string, messages: ChatMessage[]): void => {
    const payload = toStoredAskMessages(sessionId, messages);
    if (payload.length === 0) return;
    // fire-and-forget：失败静默，不影响主流程。
    void (async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch("/api/chat-messages", { method: "POST", headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }), body: JSON.stringify({ sessionId, messages: payload }) });
          if (response.ok) return;
          lastError = new Error(`chat history persistence HTTP ${response.status}`);
        } catch (error) { lastError = error; }
        await new Promise((resolve) => window.setTimeout(resolve, 250 * 2 ** attempt));
      }
      setPersistenceError(lastError instanceof Error ? lastError.message : "无法保存询问历史");
    })();
  }, []);

  const fetchServerAskMessages = useCallback(
    async (sessionId: string): Promise<StoredChatMessage[]> => {
      try {
        const response = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`, { headers: withSessionHeaders(sessionId) });
        if (!response.ok) return [];
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("messages" in payload)) return [];
        return parseStoredAskMessages((payload as { messages: unknown }).messages);
      } catch {
        return [];
      }
    },
    [],
  );

  // P2: 消息落定后持久化到服务端——debounce 800ms；流式 delta 会持续重置计时器，
  // 因此流式中途不会触发 POST，仅在询问流结束后 800ms 落库。
  useEffect(() => {
    if (!activeSessionId || ask.messages.length === 0) return;
    if (ask.messages.some((message) => message.isStreaming)) return;
    const timer = window.setTimeout(() => {
      postAskMessages(activeSessionId, ask.messages);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, ask.messages, postAskMessages]);

  // P2 → live-ask: AskPanel 常驻右栏——挂载时（或 sessionId 变化时）拉取一次服务端历史。
  // 服务端无数据且本地有消息 → 懒迁移 POST；服务端有数据 → 以服务端为准合并刷新。
  // 每个 sessionId 只拉取一次（ref 去重，兼容 StrictMode 双挂载）。
  useEffect(() => {
    if (!activeSessionId) return;
    if (lastAskSyncedSessionRef.current === activeSessionId) return;
    lastAskSyncedSessionRef.current = activeSessionId;
    const sessionId = activeSessionId;
    const syncToken = ++askSyncTokenRef.current;
    void fetchServerAskMessages(sessionId).then((serverMessages) => {
      if (askSyncTokenRef.current !== syncToken) return;
      if (serverMessages.length === 0) {
        postAskMessages(sessionId, ask.messages);
        return;
      }
      ask.setMessages(mergeAskMessages(ask.messages, serverMessages));
    });
  }, [activeSessionId, ask, fetchServerAskMessages, postAskMessages]);

  const restoreSession = useCallback((session: SessionSnapshot): void => {
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks(session.transcriptChunks);
    suggestions.setBatches(session.suggestionBatches);
    ask.setMessages(session.chatMessages);
    setMeetingReport(session.meetingReport);
    setPostmeetingTranscript(session.postmeetingTranscript ?? null);
    setTopicSummary(session.topicSummary ?? null);
    setActiveSessionId(session.id);
    const token = session.sessionAccessToken ?? loadSessionAccessToken(session.id);
    activeSessionTokenRef.current = token;
    if (token) storeSessionAccessToken(session.id, token);
    setCreatedAt(session.createdAt);
    setResumeCandidate(null);
    // P2: localStorage 快照先行渲染；sessionId 变化触发的同步 effect 会拉服务端历史，
    // 有数据则以服务端为准合并（按 createdAt 排序），无数据则懒迁移本地消息。
  }, [ask, recorder, suggestions]);

  const newSession = useCallback((): void => {
    askSyncTokenRef.current += 1; // 使在途的服务端合并失效，避免旧会话消息混入新会话
    if (recorder.isRecording) recorder.stopRecording();
    recorder.setTranscriptChunks([]);
    suggestions.setBatches([]);
    ask.setMessages([]);
    setMeetingReport(null);
    setPostmeetingTranscript(null);
    setTopicSummary(null);
    const sessionId = crypto.randomUUID();
    const sessionToken = generateClientSessionAccessToken();
    storeSessionAccessToken(sessionId, sessionToken);
    activeSessionTokenRef.current = sessionToken;
    setActiveSessionId(sessionId);
    setCreatedAt(new Date());
    setResumeCandidate(null);
  }, [ask, recorder, suggestions]);

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
      // B 阶段：会议总结纳入本次会话询问问答对（仅传 question/answer，截断由服务端负责）。
      const askHistory = extractAskExchanges(askMessagesRef.current).map(({ question, answer }) => ({ question, answer }));
      void fetch("/api/summarize", {
        method: "POST",
        headers: withSessionHeaders(activeSessionIdRef.current, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId: activeSessionIdRef.current, earlierTranscript: transcriptRef.current.map((chunk) => chunk.text).join("\n"), summarizationPrompt: END_OF_MEETING_PROMPT, polish: true, askHistory }),
      }).then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(isErrorResponseBody(payload) ? payload.error : "Could not build the meeting report");
        if (typeof payload !== "object" || payload === null || !("summary" in payload) || typeof (payload as { summary: unknown }).summary !== "string") throw new Error("Invalid meeting report response");
        const summary = (payload as { summary: string }).summary;
        setMeetingReport({ content: summary, generatedAt: new Date() });
        // M3-a：总结是导出门槛——meetingReport 非空才触发旁路 vault 导出（fire-and-forget）。
        exportMeetingSnapshotToVault(summary);
      }).catch((caught: unknown) => setPersistenceError(caught instanceof Error ? caught.message : "Could not build the meeting report")).finally(() => setIsReportLoading(false));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [generateTopicSummary, recorder.isRecording, recorder.transcriptChunks, reportRequested, exportMeetingSnapshotToVault]);

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

  // 建议刷新倒计时（建议卡 UI 移除后由顶栏承接，生成节奏不变）：录音期间每秒走一格。
  const [refreshNow, setRefreshNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isCardFlowActive || suggestions.nextRefreshAt === null) return;
    const id = window.setInterval(() => setRefreshNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isCardFlowActive, suggestions.nextRefreshAt]);
  const refreshSeconds = suggestions.nextRefreshAt === null ? null : Math.max(0, Math.ceil((suggestions.nextRefreshAt - refreshNow) / 1000));

  // 批次三：当前有效建议 = 最新批次过滤 dismissed + 锚点命中（未命中的不传给左栏）。
  const activeSuggestions = useMemo(
    () => (suggestions.batches[0]?.suggestions ?? []).filter(
      (suggestion) =>
        !(suggestion.id !== undefined && suggestions.dismissedIds.has(suggestion.id)) &&
        matchSuggestionAnchor(suggestion, recorder.transcriptChunks) !== null,
    ),
    [recorder.transcriptChunks, suggestions.batches, suggestions.dismissedIds],
  );

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
    // 仅桌面模式显示输入源模式；浏览器录音没有该概念。
    ...(desktopRecorder.isDesktop ? { sourceMode: AUDIO_SOURCE_MODE_LABELS[desktopRecorder.audioSourceMode] } : {}),
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
          <button type="button" disabled={recorder.isRecording || recorder.transcriptChunks.length === 0 || isPostmeetingLoading} onClick={polishPostmeetingTranscript} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 disabled:opacity-40">
            {isPostmeetingLoading ? "整理中…" : postmeetingTranscript ? "重新整理" : "整理转写"}
          </button>
          {postmeetingTranscript ? <button type="button" disabled={!hasContent} onClick={() => exportSession(snapshot, "md", { transcript: "polished" })} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 disabled:opacity-40">整理版</button> : null}
          <button type="button" disabled={!hasContent} onClick={() => exportSession(snapshot, "md", { redacted: true })} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 disabled:opacity-40">脱敏</button>
          <button
            type="button"
            onClick={manualRefresh}
            disabled={suggestions.isLoading}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
          >
            ↺ 刷新建议
          </button>
          <span className="hidden text-[10px] text-neutral-600 sm:inline">
            {isCardFlowActive && refreshSeconds !== null ? `${refreshSeconds} 秒后自动刷新` : "开始录音后自动刷新"}
          </span>
          {suggestions.error ? (
            <span className="hidden max-w-48 truncate text-[10px] text-red-400 sm:inline" title={suggestions.error}>
              建议：{suggestions.error}
            </span>
          ) : null}
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
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        health={{
          asrStatus,
          uploadStatus,
          cardCount: contextCards.cards.length,
          failureCount: contextCards.failures.length,
          latestTotalLatencyMs: contextCards.cards[0]?.latencyMs.total ?? null,
          latencySummaries,
          queueStatus: desktopRecorder.error?.includes("队列") ? "有待处理" : "正常",
          degradationStatus: contextCards.cards.some((card) => card.demoTrace && card.demoTrace.decisionSource !== "model") ? "已启用" : null,
        }}
      />
      <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col lg:flex-row [&>section]:min-w-0">
        <MicTranscript
          transcriptChunks={recorder.transcriptChunks}
          isRecording={recorder.isRecording}
          isPaused={recorder.isPaused}
          partialText={recorder === browserRecorder ? browserRecorder.partialText : null}
          micLevel={recorder.micLevel}
          retryCount={recorder.retryCount}
          onRecordingChange={handleRecordingChange}
          onPauseToggle={recorder.isPaused ? recorder.resumeRecording : recorder.pauseRecording}
          recordingError={recorder.error}
          meetingReport={meetingReport}
          isReportLoading={isReportLoading}
          isUploadProcessing={uploader.isProcessing}
          isDesktop={desktopRecorder.isDesktop}
          audioSourceMode={desktopRecorder.audioSourceMode}
          onAudioSourceModeChange={desktopRecorder.setAudioSourceMode}
          suggestions={activeSuggestions}
          onSuggestionAsk={(suggestion) => setAskDraft(suggestion.preview)}
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
        <ContextCardsPanel
          cards={contextCards.cards}
          failures={contextCards.failures}
          isLoading={contextCards.isLoading}
          error={contextCards.error}
          onCardDeposit={handleCardDeposit}
          depositedCardIds={depositedCardIds}
          onAskMore={(term) => setAskTermHint(term)}
          onMarkUseful={handleMarkUseful}
          usefulCandidateIds={usefulCandidateIds}
        />
        <AskPanel
          messages={ask.messages}
          phase={ask.phase}
          busy={ask.busy}
          sendQuestion={ask.sendQuestion}
          error={ask.error}
          stopGenerating={ask.stopGenerating}
          retryLastFailed={ask.retryLastFailed}
          canRetry={ask.canRetry}
          draftQuestion={askDraft}
          termHint={askTermHint}
        />
      </main>
    </div>
  );
}
