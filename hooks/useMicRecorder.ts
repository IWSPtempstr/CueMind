"use client";

// 范围（master plan 2.1 裁决）：partial 转写仅麦克风链路（决策 66）——桌面链路
// 5s chunk 已近实时、上传链路有 SSE 进度，均不做。
// 红线：partial 只进 partialText 展示态，绝不写 transcriptChunks、绝不触发
// context-cards。卡片链路只消费 confirmed 文本：transcriptChunks 变化才由
// page.tsx 的 effect 驱动 /api/context-cards，partial 不进该 state，天然隔离。

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { withSessionHeaders } from "@/lib/client-session-auth";
import {
  freshThrottleState,
  onConfirmed,
  onPartialSent,
  shouldSendPartial,
  type PartialThrottleState,
} from "@/lib/partial-transcript";
import {
  appendPipelineEvent,
  createPipelineEvent,
  persistPipelineEvent,
  type PipelineEvent,
  type RequestTimelineEventName,
} from "@/lib/request-timeline";
import type { TranscriptChunk } from "@/types/session";

const MIN_TRANSCRIBE_BYTES = 1000;
const TRANSCRIBE_UPLOAD_FILENAME = "chunk.webm";
const AUDIO_WEBM_FALLBACK_MIME = "audio/webm";
const RECORDER_OVERLAP_MS = 1000;
const SILENCE_RMS_THRESHOLD = 0.012;
const MAX_RETRY_ATTEMPTS = 4;
// timeslice 让 ondataavailable 每 1s 落一个 webm cluster——partial 转写才有
// "进行中"的音频可读（无 timeslice 时 parts 直到 stop 才有数据）。
// 多 cluster webm 拼接对 ffmpeg/whisper 仍是合法输入，confirmed 路径不受影响。
const RECORDER_TIMESLICE_MS = 1000;
// partial 调度循环的 tick 周期；真实发送节奏由 shouldSendPartial 的 ≥4s 节流决定。
const PARTIAL_TICK_MS = 1000;

interface Segment {
  recorder: MediaRecorder;
  parts: Blob[];
  startedAt: Date;
  peakLevel: number;
  runId: string;
  asrTraced: boolean;
  asrEnded: boolean;
}

interface UploadMediaChunkResponse { text: string }
interface UploadMediaSuccessResponse { chunks: UploadMediaChunkResponse[] }
interface TranscribeErrorResponse { error: string }

interface UseMicRecorderResult {
  isRecording: boolean;
  isPaused: boolean;
  micLevel: number;
  retryCount: number;
  transcriptChunks: TranscriptChunk[];
  /** 进行中 segment 的临时转写（决策 66 partial 态）；confirmed 到达后被清除。 */
  partialText: string | null;
  setTranscriptChunks: (chunks: TranscriptChunk[]) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  flushCurrentChunk: () => void;
  error: string | null;
  pipelineEvents: PipelineEvent[];
}

function isTranscribeSuccess(value: unknown): value is UploadMediaSuccessResponse {
  return typeof value === "object" && value !== null && "chunks" in value && Array.isArray((value as UploadMediaSuccessResponse).chunks);
}

function isTranscribeError(value: unknown): value is TranscribeErrorResponse {
  return typeof value === "object" && value !== null && "error" in value && typeof (value as TranscribeErrorResponse).error === "string";
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  return undefined;
}

/** confirmed 与 partial 请求共用的 /api/upload-media FormData 组装（同一契约，避免重复）。 */
function buildTranscribeFormData(blob: Blob, settings: ReturnType<typeof loadCueMindSettings>, runId: string): FormData {
  const formData = new FormData();
  formData.append("media", blob, TRANSCRIBE_UPLOAD_FILENAME);
  if (settings.localWhisperLanguage !== "auto") formData.append("language", settings.localWhisperLanguage);
  formData.append("uploadId", runId);
  formData.append("runId", runId);
  return formData;
}

export default function useMicRecorder(sessionId?: string | null): UseMicRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [transcriptChunks, setTranscriptState] = useState<TranscriptChunk[]>([]);
  const [partialText, setPartialText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const segmentsRef = useRef(new Set<Segment>());
  const primarySegmentRef = useRef<Segment | null>(null);
  const rotationTimerRef = useRef<number | null>(null);
  const overlapTimerRef = useRef<number | null>(null);
  const isStoppingRef = useRef(false);
  const mimeTypeRef = useRef<string | undefined>(undefined);
  const cadenceMsRef = useRef(30_000);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const retryTimersRef = useRef(new Set<number>());
  // partial 转写通道（决策 66）：节流状态单飞 + 每 1s tick 判定（见 shouldSendPartial）。
  const partialTimerRef = useRef<number | null>(null);
  const partialThrottleRef = useRef<PartialThrottleState>({ lastSentAt: 0, inFlight: false });
  // 当前 partial 循环的属主 segment（轮换/flush 换主后旧循环随之作废）。
  const partialSegmentRef = useRef<Segment | null>(null);
  const pipelineEventsRef = useRef<PipelineEvent[]>([]);
  const pipelineByRunRef = useRef(new Map<string, PipelineEvent[]>());

  const emitPipelineEvent = useCallback((runId: string, name: RequestTimelineEventName, metadata?: unknown): void => {
    try {
      const event = createPipelineEvent(runId, name, monotonicNow(), metadata);
      const runEvents = pipelineByRunRef.current.get(runId) ?? [];
      appendPipelineEvent(runEvents, event);
      persistPipelineEvent(event, sessionId);
      pipelineByRunRef.current.set(runId, runEvents);
      pipelineEventsRef.current.push(event);
      setPipelineEvents([...pipelineEventsRef.current]);
    } catch {
      // Telemetry is best-effort and must never interrupt recording/transcription.
    }
  }, [sessionId]);

  const setTranscriptChunks = useCallback((chunks: TranscriptChunk[]): void => {
    setTranscriptState(chunks);
  }, []);

  const clearRotationTimers = useCallback((): void => {
    if (rotationTimerRef.current !== null) window.clearTimeout(rotationTimerRef.current);
    if (overlapTimerRef.current !== null) window.clearTimeout(overlapTimerRef.current);
    rotationTimerRef.current = null;
    overlapTimerRef.current = null;
  }, []);

  const clearPartialTimer = useCallback((): void => {
    if (partialTimerRef.current !== null) window.clearInterval(partialTimerRef.current);
    partialTimerRef.current = null;
  }, []);

  const cleanupMeter = useCallback((): void => {
    if (meterFrameRef.current !== null) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close();
    setMicLevel(0);
  }, []);

  const cleanupStream = useCallback((): void => {
    clearRotationTimers();
    cleanupMeter();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    primarySegmentRef.current = null;
    segmentsRef.current.clear();
  }, [clearRotationTimers, cleanupMeter]);

  /** 单次转写请求（confirmed 与 partial 共用）；抛错由调用方决定重试或静默。 */
  const transcribeBlobOnce = useCallback(async (blob: Blob, runId: string): Promise<string> => {
    const response = await fetch("/api/upload-media", {
      method: "POST",
      headers: withSessionHeaders(sessionId, { "X-Session-Id": sessionId ?? "" }),
      body: buildTranscribeFormData(blob, loadCueMindSettings(), runId),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(isTranscribeError(payload) ? payload.error : "Transcription failed");
    return isTranscribeSuccess(payload)
      ? payload.chunks.map((chunk) => (typeof chunk.text === "string" ? chunk.text : "")).join(" ").trim()
      : "";
  }, [sessionId]);

  const transcribeBlob = useCallback(async (blob: Blob, timestamp: Date, segment: Segment, attempt = 1): Promise<void> => {
    if (!segment.asrTraced) {
      segment.asrTraced = true;
      emitPipelineEvent(segment.runId, "asr_start", { source: "microphone", status: "confirmed" });
    }
    try {
      const text = await transcribeBlobOnce(blob, segment.runId);
      if (text) {
        setTranscriptState((previous) => [
          ...previous,
          { id: crypto.randomUUID(), text, timestamp, pipelineRunId: segment.runId },
        ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()));
      }
      // confirmed 文本已落账：清掉同 segment 的 partial 展示并重置节流周期
      // （决策 66 替换语义，onConfirmed 开启下一个 partial 周期）。
      partialThrottleRef.current = onConfirmed(partialThrottleRef.current);
      setPartialText(null);
      setError(null);
      if (!segment.asrEnded) {
        segment.asrEnded = true;
        emitPipelineEvent(segment.runId, "asr_end", { source: "microphone", status: "confirmed" });
      }
    } catch (caught) {
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        segment.asrEnded = true;
        emitPipelineEvent(segment.runId, "asr_end", { source: "microphone", status: "error", errorCode: "retry_exhausted" });
        setError(caught instanceof Error ? `${caught.message} (audio kept through 4 retries)` : "Transcription failed after retries.");
        return;
      }
      setRetryCount((count) => count + 1);
      const timer = window.setTimeout(() => {
        retryTimersRef.current.delete(timer);
        void transcribeBlob(blob, timestamp, segment, attempt + 1).finally(() => {
          setRetryCount((count) => Math.max(0, count - 1));
        });
      }, 1000 * 2 ** (attempt - 1));
      retryTimersRef.current.add(timer);
      setError(`Transcription paused by a hiccup — retry ${attempt} queued.`);
    }
  }, [emitPipelineEvent, transcribeBlobOnce]);

  /**
   * partial 转写（决策 66）：进行中 segment 的临时文本，尽力而为——失败静默丢弃、
   * 不重试（partial 丢了等下一 tick 即可）、不进 error 状态。响应只在仍是当前主
   * segment 时才落 partialText；绝不写 transcriptChunks / 不触发 context-cards
   * （见文件头红线注释）。
   */
  const runPartialTranscription = useCallback(async (segment: Segment): Promise<void> => {
    if (isStoppingRef.current) return;
    const nowMs = Date.now();
    if (!shouldSendPartial(partialThrottleRef.current, nowMs, {
      // MediaRecorder.pause() 会把 state 置为 "paused"，此处天然覆盖暂停语义。
      isRecording: segment.recorder.state === "recording" && !isStoppingRef.current,
      hasInFlight: partialThrottleRef.current.inFlight,
      accumulatedBytes: segment.parts.reduce((total, part) => total + part.size, 0),
    })) return;
    partialThrottleRef.current = onPartialSent(partialThrottleRef.current, nowMs);
    partialThrottleRef.current = { ...partialThrottleRef.current, inFlight: true };
    try {
      const blob = new Blob(segment.parts, { type: mimeTypeRef.current ?? AUDIO_WEBM_FALLBACK_MIME });
      if (!segment.asrTraced) {
        segment.asrTraced = true;
        emitPipelineEvent(segment.runId, "asr_start", { source: "microphone", status: "partial" });
      }
      const text = await transcribeBlobOnce(blob, segment.runId);
      // 只有时序仍一致的当前主 segment 才允许更新 partial（旧 segment/已停止则丢弃）。
      if (!isStoppingRef.current && segment.recorder.state === "recording" && primarySegmentRef.current === segment) {
        setPartialText(text || null);
      }
    } catch {
      // partial 是尽力而为的展示层：失败保持上一帧，静默丢弃。
    } finally {
      partialThrottleRef.current = { ...partialThrottleRef.current, inFlight: false };
    }
  }, [emitPipelineEvent, transcribeBlobOnce]);

  /** 每个 segment 创建时起一个 partial 调度循环：每 1s tick，由 shouldSendPartial 节流（两段式：首 2s、后续 4s）。 */
  const schedulePartialRef = useRef<(segment: Segment) => void>(() => undefined);
  schedulePartialRef.current = (segment: Segment): void => {
    clearPartialTimer();
    partialSegmentRef.current = segment;
    // 新 segment：重置节流周期，以创建时刻为首个 partial 的门限基准。
    partialThrottleRef.current = freshThrottleState(Date.now());
    partialTimerRef.current = window.setInterval(() => {
      void runPartialTranscription(segment);
    }, PARTIAL_TICK_MS);
  };

  const finalizeSegment = useCallback((segment: Segment): void => {
    segmentsRef.current.delete(segment);
    // 属主 segment 停止：清掉它的 partial 循环，confirmed 转写接棒（决策 66 替换语义）。
    if (partialSegmentRef.current === segment) {
      clearPartialTimer();
      partialSegmentRef.current = null;
    }
    const blob = new Blob(segment.parts, { type: mimeTypeRef.current ?? AUDIO_WEBM_FALLBACK_MIME });
    emitPipelineEvent(segment.runId, "capture_end", { source: "microphone", status: "ok" });
    if (blob.size >= MIN_TRANSCRIBE_BYTES && segment.peakLevel >= SILENCE_RMS_THRESHOLD) {
      void transcribeBlob(blob, segment.startedAt, segment);
    }
    if (isStoppingRef.current && segmentsRef.current.size === 0) cleanupStream();
  }, [cleanupStream, clearPartialTimer, emitPipelineEvent, transcribeBlob]);

  const createSegment = useCallback((stream: MediaStream): Segment | null => {
    try {
      const recorder = mimeTypeRef.current
        ? new MediaRecorder(stream, { mimeType: mimeTypeRef.current })
        : new MediaRecorder(stream);
      const segment: Segment = { recorder, parts: [], startedAt: new Date(), peakLevel: analyserRef.current ? 0 : 1, runId: crypto.randomUUID(), asrTraced: false, asrEnded: false };
      emitPipelineEvent(segment.runId, "capture_start", { source: "microphone", status: "recording" });
      recorder.ondataavailable = (event) => { if (event.data.size > 0) segment.parts.push(event.data); };
      recorder.onerror = () => setError("Recording error.");
      recorder.onstop = () => finalizeSegment(segment);
      segmentsRef.current.add(segment);
      // timeslice 落 cluster 供 partial 读取（见 RECORDER_TIMESLICE_MS 注释）。
      recorder.start(RECORDER_TIMESLICE_MS);
      schedulePartialRef.current(segment);
      return segment;
    } catch {
      setError("Could not create MediaRecorder for this device.");
      return null;
    }
  }, [emitPipelineEvent, finalizeSegment]);

  const scheduleRotationRef = useRef<(segment: Segment) => void>(() => undefined);
  scheduleRotationRef.current = (segment: Segment): void => {
    clearRotationTimers();
    const leadTime = Math.max(1000, cadenceMsRef.current - RECORDER_OVERLAP_MS);
    rotationTimerRef.current = window.setTimeout(() => {
      const stream = streamRef.current;
      if (!stream || isStoppingRef.current || segment.recorder.state !== "recording") return;
      const next = createSegment(stream);
      if (!next) return;
      primarySegmentRef.current = next;
      overlapTimerRef.current = window.setTimeout(() => {
        if (segment.recorder.state !== "inactive") segment.recorder.stop();
        scheduleRotationRef.current(next);
      }, RECORDER_OVERLAP_MS);
    }, leadTime);
  };

  const startMeter = useCallback((stream: MediaStream): void => {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
      const samples = new Uint8Array(analyser.fftSize);
      const measure = (): void => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        setMicLevel(level);
        for (const segment of segmentsRef.current) segment.peakLevel = Math.max(segment.peakLevel, level);
        meterFrameRef.current = requestAnimationFrame(measure);
      };
      measure();
    } catch {
      // Recording still works when Web Audio is unavailable.
    }
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);
    const settings = loadCueMindSettings();
    if (!settings.localWhisperPath.trim() || !settings.localWhisperModelPath.trim()) {
      setError("浏览器麦克风实时转写需要先在设置中填写 whisper.cpp 可执行文件和模型路径");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("MediaRecorder is not supported in this browser.");
      return;
    }
    if (streamRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (caught) {
      setError(caught instanceof DOMException && caught.name === "NotAllowedError" ? "Microphone permission denied." : "Could not access the microphone.");
      return;
    }

    cadenceMsRef.current = settings.chunkIntervalSeconds * 1000;
    streamRef.current = stream;
    mimeTypeRef.current = pickMimeType();
    isStoppingRef.current = false;
    startMeter(stream);
    const segment = createSegment(stream);
    if (!segment) {
      cleanupStream();
      return;
    }
    primarySegmentRef.current = segment;
    scheduleRotationRef.current(segment);
    setIsPaused(false);
    setIsRecording(true);
  }, [cleanupStream, createSegment, startMeter]);

  const stopRecording = useCallback((): void => {
    clearRotationTimers();
    // 停止：清理所有 partial interval + 清空 partial 展示态（confirmed 接棒）。
    clearPartialTimer();
    partialSegmentRef.current = null;
    isStoppingRef.current = true;
    setIsRecording(false);
    setIsPaused(false);
    setPartialText(null);
    const segments = [...segmentsRef.current];
    if (segments.length === 0) cleanupStream();
    for (const segment of segments) if (segment.recorder.state !== "inactive") segment.recorder.stop();
  }, [cleanupStream, clearPartialTimer, clearRotationTimers]);

  const pauseRecording = useCallback((): void => {
    if (!isRecording || isPaused) return;
    clearRotationTimers();
    clearPartialTimer();
    setPartialText(null);
    const primary = primarySegmentRef.current;
    for (const segment of [...segmentsRef.current]) {
      if (segment !== primary && segment.recorder.state !== "inactive") segment.recorder.stop();
    }
    if (primary?.recorder.state === "recording") primary.recorder.pause();
    setIsPaused(true);
    setMicLevel(0);
  }, [clearPartialTimer, clearRotationTimers, isPaused, isRecording]);

  const resumeRecording = useCallback((): void => {
    const primary = primarySegmentRef.current;
    if (!isRecording || !isPaused || !primary) return;
    if (primary.recorder.state === "paused") primary.recorder.resume();
    scheduleRotationRef.current(primary);
    schedulePartialRef.current(primary);
    setIsPaused(false);
  }, [isPaused, isRecording]);

  const flushCurrentChunk = useCallback((): void => {
    const primary = primarySegmentRef.current;
    const stream = streamRef.current;
    if (!primary || !stream || primary.recorder.state !== "recording" || isStoppingRef.current) return;
    clearRotationTimers();
    // Stop the primary plus any recorder still lingering in an overlap window,
    // so a manual flush never strands an orphan segment recording forever.
    for (const segment of [...segmentsRef.current]) {
      if (segment.recorder.state === "recording") segment.recorder.stop();
    }
    const next = createSegment(stream);
    if (next) {
      primarySegmentRef.current = next;
      scheduleRotationRef.current(next);
    }
  }, [clearRotationTimers, createSegment]);

  useEffect(() => () => {
    clearRotationTimers();
    clearPartialTimer();
    cleanupMeter();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    for (const timer of retryTimersRef.current) window.clearTimeout(timer);
  }, [clearRotationTimers, clearPartialTimer, cleanupMeter]);

  return { isRecording, isPaused, micLevel, retryCount, transcriptChunks, partialText, setTranscriptChunks, startRecording, stopRecording, pauseRecording, resumeRecording, flushCurrentChunk, error, pipelineEvents };
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
