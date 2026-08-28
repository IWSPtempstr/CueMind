"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { PARTIAL_INTERVAL_MS, shouldRunPartialTranscription } from "@/lib/partial-transcription";
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

interface Segment {
  recorder: MediaRecorder;
  parts: Blob[];
  startedAt: Date;
  peakLevel: number;
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

export default function useMicRecorder(): UseMicRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [transcriptChunks, setTranscriptState] = useState<TranscriptChunk[]>([]);
  const [partialText, setPartialText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  // partial 转写通道（决策 66）：单飞 + 节流 + 主 segment 守卫。
  const partialTimerRef = useRef<number | null>(null);
  const partialInFlightRef = useRef(false);
  const lastPartialAttemptRef = useRef<number | null>(null);

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
    if (partialTimerRef.current !== null) window.clearTimeout(partialTimerRef.current);
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
  const transcribeBlobOnce = useCallback(async (blob: Blob): Promise<string> => {
    const settings = loadCueMindSettings();
    const formData = new FormData();
    formData.append("media", blob, TRANSCRIBE_UPLOAD_FILENAME);
    if (settings.localWhisperLanguage !== "auto") formData.append("language", settings.localWhisperLanguage);
    formData.append("whisperPath", settings.localWhisperPath);
    formData.append("whisperModelPath", settings.localWhisperModelPath);
    formData.append("uploadId", crypto.randomUUID());

    const response = await fetch("/api/upload-media", {
      method: "POST",
      body: formData,
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error(isTranscribeError(payload) ? payload.error : "Transcription failed");
    return isTranscribeSuccess(payload)
      ? payload.chunks.map((chunk) => (typeof chunk.text === "string" ? chunk.text : "")).join(" ").trim()
      : "";
  }, []);

  const transcribeBlob = useCallback(async (blob: Blob, timestamp: Date, attempt = 1): Promise<void> => {
    try {
      const text = await transcribeBlobOnce(blob);
      if (text) {
        setTranscriptState((previous) => [
          ...previous,
          { id: crypto.randomUUID(), text, timestamp },
        ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()));
      }
      // confirmed 文本已落账：清掉同 segment 的 partial 展示（决策 66 替换语义）。
      setPartialText(null);
      setError(null);
    } catch (caught) {
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        setError(caught instanceof Error ? `${caught.message} (audio kept through 4 retries)` : "Transcription failed after retries.");
        return;
      }
      setRetryCount((count) => count + 1);
      const timer = window.setTimeout(() => {
        retryTimersRef.current.delete(timer);
        void transcribeBlob(blob, timestamp, attempt + 1).finally(() => {
          setRetryCount((count) => Math.max(0, count - 1));
        });
      }, 1000 * 2 ** (attempt - 1));
      retryTimersRef.current.add(timer);
      setError(`Transcription paused by a hiccup — retry ${attempt} queued.`);
    }
  }, [transcribeBlobOnce]);

  /** partial 转写：进行中 segment 的临时文本（决策 66）；单飞 + 节流 + 主 segment 守卫，失败静默。 */
  const runPartialTranscription = useCallback(async (segment: Segment): Promise<void> => {
    if (isStoppingRef.current || partialInFlightRef.current) return;
    const blob = new Blob(segment.parts, { type: mimeTypeRef.current ?? AUDIO_WEBM_FALLBACK_MIME });
    const nowMs = Date.now();
    if (!shouldRunPartialTranscription({
      inFlight: partialInFlightRef.current,
      segmentState: segment.recorder.state,
      blobSize: blob.size,
      peakLevel: segment.peakLevel,
      nowMs,
      lastAttemptMs: lastPartialAttemptRef.current,
      silenceThreshold: SILENCE_RMS_THRESHOLD,
    })) return;
    lastPartialAttemptRef.current = nowMs;
    partialInFlightRef.current = true;
    try {
      const text = await transcribeBlobOnce(blob);
      // 只有时序仍一致的当前主 segment 才允许更新 partial（旧 segment/已停止则丢弃）。
      if (!isStoppingRef.current && segment.recorder.state === "recording" && primarySegmentRef.current === segment) {
        setPartialText(text && text.trim() ? text.trim() : null);
      }
    } catch {
      // partial 是尽力而为的展示层：失败保持上一帧，不进 error 状态。
    } finally {
      partialInFlightRef.current = false;
    }
  }, [transcribeBlobOnce]);

  const schedulePartialRef = useRef<(segment: Segment) => void>(() => undefined);
  schedulePartialRef.current = (segment: Segment): void => {
    if (partialTimerRef.current !== null) window.clearTimeout(partialTimerRef.current);
    const tick = (): void => {
      partialTimerRef.current = null;
      void runPartialTranscription(segment).finally(() => {
        if (!isStoppingRef.current && segment.recorder.state === "recording") {
          partialTimerRef.current = window.setTimeout(tick, PARTIAL_INTERVAL_MS);
        }
      });
    };
    partialTimerRef.current = window.setTimeout(tick, PARTIAL_INTERVAL_MS);
  };

  const finalizeSegment = useCallback((segment: Segment): void => {
    segmentsRef.current.delete(segment);
    const blob = new Blob(segment.parts, { type: mimeTypeRef.current ?? AUDIO_WEBM_FALLBACK_MIME });
    if (blob.size >= MIN_TRANSCRIBE_BYTES && segment.peakLevel >= SILENCE_RMS_THRESHOLD) {
      void transcribeBlob(blob, segment.startedAt);
    }
    if (isStoppingRef.current && segmentsRef.current.size === 0) cleanupStream();
  }, [cleanupStream, transcribeBlob]);

  const createSegment = useCallback((stream: MediaStream): Segment | null => {
    try {
      const recorder = mimeTypeRef.current
        ? new MediaRecorder(stream, { mimeType: mimeTypeRef.current })
        : new MediaRecorder(stream);
      const segment: Segment = { recorder, parts: [], startedAt: new Date(), peakLevel: analyserRef.current ? 0 : 1 };
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
  }, [finalizeSegment]);

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
    clearPartialTimer();
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

  return { isRecording, isPaused, micLevel, retryCount, transcriptChunks, partialText, setTranscriptChunks, startRecording, stopRecording, pauseRecording, resumeRecording, flushCurrentChunk, error };
}
