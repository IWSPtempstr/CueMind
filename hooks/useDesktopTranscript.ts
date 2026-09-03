"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { withSessionHeaders } from "@/lib/client-session-auth";
import type { AudioSourceMode } from "@/lib/audio-source-mode";
import { parseDesktopEvent, type AudioChunkReadyEvent } from "@/lib/desktop-events";
import { attributeChunkSpeaker } from "@/lib/speaker-attributes";
import type { LatencySample } from "@/lib/telemetry";
import {
  appendPipelineEvent,
  createPipelineEvent,
  persistPipelineEvent,
  type PipelineEvent,
  type RequestTimelineEventName,
} from "@/lib/request-timeline";
import type { TranscriptChunk } from "@/types/session";

/** 最近事件窗口容量（≈5 分钟双轨 5s chunk；说话人归属只关心近邻对轨）。 */
const RECENT_EVENTS_LIMIT = 60;

interface UseDesktopTranscriptResult {
  isDesktop: boolean;
  isRecording: boolean;
  isPaused: boolean;
  micLevel: number;
  retryCount: number;
  error: string | null;
  transcriptChunks: TranscriptChunk[];
  setTranscriptChunks: (chunks: TranscriptChunk[]) => void;
  audioSourceMode: AudioSourceMode;
  setAudioSourceMode: (mode: AudioSourceMode) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  flushCurrentChunk: () => void;
  latencySamples: LatencySample[];
  pipelineEvents: PipelineEvent[];
}

export default function useDesktopTranscript(sessionId?: string | null): UseDesktopTranscriptResult {
  const [isDesktop, setIsDesktop] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptChunks, setTranscriptState] = useState<TranscriptChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [audioSourceMode, setAudioSourceModeState] = useState<AudioSourceMode>("mixed");
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);
  const queueRef = useRef<AudioChunkReadyEvent[]>([]);
  const processingRef = useRef(false);
  const seenChunkIdsRef = useRef(new Set<string>());
  // 最近的双轨事件窗口（供说话人归属做对轨时间重叠比较；有界防长会话膨胀）。
  const recentEventsRef = useRef<AudioChunkReadyEvent[]>([]);
  const audioSourceModeRef = useRef<AudioSourceMode>("mixed");
  // 已同步到主进程的输入源模式；startRecording 前据此判断是否需要先同步。
  const appliedAudioSourceModeRef = useRef<AudioSourceMode>("mixed");
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
      // Telemetry is best-effort and must not interrupt desktop capture.
    }
  }, [sessionId]);

  useEffect(() => {
    setIsDesktop(Boolean(window.cuemindDesktop));
  }, []);

  useEffect(() => {
    audioSourceModeRef.current = audioSourceMode;
  }, [audioSourceMode]);

  const setTranscriptChunks = useCallback((chunks: TranscriptChunk[]): void => {
    setTranscriptState(chunks);
  }, []);

  const transcribeChunk = useCallback(async (event: AudioChunkReadyEvent): Promise<void> => {
    const runId = crypto.randomUUID();
    emitPipelineEvent(runId, "capture_start", { source: event.source, status: "ready" });
    const settings = loadCueMindSettings();
    if (!settings.localWhisperPath.trim() || !settings.localWhisperModelPath.trim()) {
      emitPipelineEvent(runId, "capture_end", { source: event.source, status: "error", errorCode: "missing_whisper_settings" });
      setError("请先在设置中填写 whisper.cpp 可执行文件和模型路径。");
      return;
    }

    emitPipelineEvent(runId, "capture_end", { source: event.source, status: "ok" });
    emitPipelineEvent(runId, "asr_start", { source: event.source, status: "confirmed" });
    const asrStartedAt = new Date();
    try {
      const response = await fetch("/api/local-transcribe", {
        method: "POST",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId,
          audioPath: event.path,
          runId,
          source: event.source,
          startMs: event.startMs,
          endMs: event.endMs,
          settings: {
            whisperPath: settings.localWhisperPath,
            modelPath: settings.localWhisperModelPath,
            language: settings.localWhisperLanguage,
            timeoutMs: 60_000,
          },
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isTranscribePayload(payload)) {
        throw new Error(isErrorPayload(payload) ? payload.error : "本地转写失败");
      }
      emitPipelineEvent(runId, "asr_end", { source: event.source, status: "confirmed" });
      if (!payload.text.trim()) return;

      const asrEndedAt = new Date();
      setLatencySamples((previous) => [
        ...previous,
        { id: crypto.randomUUID(), stage: "capture", durationMs: Math.max(0, event.endMs - event.startMs), createdAt: new Date() },
        { id: crypto.randomUUID(), stage: "asr", durationMs: payload.latencyMs, createdAt: asrEndedAt },
      ]);
      // 说话人归属（2.2-b 接线）：仅 mixed 双轨模式标注（attributeChunkSpeaker 内裁决），
      // 单轨（mic|system 模式）chunk 不带 speaker（行为零变化红线）。C# 已透出 energy
      // 字段（窗口峰值 RMS）→ 直接作为 peakLevel 参与重叠区能量比较与泄漏跟随
      // （lib/speaker-attributes.ts）；旧 helper 无 energy → 纯通道映射退化路径。
      const otherTrack = recentEventsRef.current
        .filter((item) => item.id !== event.id && (item.source === "microphone" || item.source === "system") && item.source !== event.source)
        .map((item) => ({
          source: item.source as "microphone" | "system",
          startMs: item.startMs,
          endMs: item.endMs,
          ...(typeof item.energy === "number" ? { peakLevel: item.energy } : {}),
        }));
      const speaker = attributeChunkSpeaker(audioSourceModeRef.current, event.source, event.startMs, event.endMs, otherTrack, event.energy);
      setTranscriptState((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          text: payload.text.trim(),
          pipelineRunId: runId,
          timestamp: new Date(event.startedAt),
          source: event.source,
          ...(speaker ? { speaker } : {}),
          startMs: event.startMs,
          endMs: event.endMs,
          latency: {
            captureStartedAt: new Date(event.startedAt),
            captureEndedAt: new Date(event.endedAt),
            asrStartedAt,
            asrEndedAt,
          },
        },
      ].sort(compareChunks));
      setError(null);
    } catch (caught) {
      emitPipelineEvent(runId, "asr_end", { source: event.source, status: "error", errorCode: "local_transcribe_failed" });
      setError(caught instanceof Error ? caught.message : "本地转写失败");
    }
  }, [emitPipelineEvent, sessionId]);

  const enqueueChunk = useCallback((event: AudioChunkReadyEvent): void => {
    if (seenChunkIdsRef.current.has(event.id)) return;
    seenChunkIdsRef.current.add(event.id);
    // 记入近邻事件窗口（说话人归属的对轨比较源）。
    recentEventsRef.current.push(event);
    if (recentEventsRef.current.length > RECENT_EVENTS_LIMIT) {
      recentEventsRef.current.splice(0, recentEventsRef.current.length - RECENT_EVENTS_LIMIT);
    }
    if (queueRef.current.length >= 3) {
      queueRef.current.shift();
      setError("本地转写队列已满，已丢弃最旧的待处理音频片段。");
    }
    queueRef.current.push(event);
    // Capture begins when the helper announces a completed audio window to the renderer.
    if (processingRef.current) return;
    processingRef.current = true;
    void (async () => {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (next) await transcribeChunk(next);
      }
      processingRef.current = false;
    })();
  }, [transcribeChunk]);

  useEffect(() => {
    const bridge = window.cuemindDesktop;
    if (!bridge) return;

    return bridge.onRuntimeEvent((raw) => {
      const event = parseDesktopEvent(raw);
      if (!event) return;
      if (event.type === "runtime_error") {
        setError(event.message);
      } else if (event.type === "audio_chunk_ready") {
        enqueueChunk(event);
      }
    });
  }, [enqueueChunk]);

  // 切换输入源模式：更新本地 state；桌面环境存在桥时同步主进程（helper 在跑则主进程会重启）。
  // 非桌面环境仅更新本地 state（no-op）。
  const setAudioSourceMode = useCallback((mode: AudioSourceMode): void => {
    setAudioSourceModeState(mode);
    const bridge = window.cuemindDesktop;
    if (typeof bridge?.setAudioSourceMode !== "function") return;
    void bridge.setAudioSourceMode(mode).then((status) => {
      if (status.lastError) {
        setError(status.lastError);
        return;
      }
      appliedAudioSourceModeRef.current = mode;
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "切换输入源失败");
    });
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    const bridge = window.cuemindDesktop;
    if (!bridge) {
      setError("桌面运行时不可用，将继续使用浏览器录音。");
      return;
    }
    // 确保以当前选择的输入源模式启动：模式与已同步值不同时，先同步主进程（helper 在跑则重启）。
    const desiredMode = audioSourceModeRef.current;
    if (typeof bridge.setAudioSourceMode === "function" && appliedAudioSourceModeRef.current !== desiredMode) {
      try {
        const status = await bridge.setAudioSourceMode(desiredMode);
        if (status.lastError) {
          setError(status.lastError);
          return;
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "切换输入源失败");
        return;
      }
    }
    const status = await bridge.startAudioHelper();
    if (status.lastError) {
      setError(status.lastError);
      return;
    }
    appliedAudioSourceModeRef.current = desiredMode;
    setError(null);
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback((): void => {
    if (!window.cuemindDesktop) return;
    void window.cuemindDesktop.stopAudioHelper().then((status) => {
      if (status.lastError) setError(status.lastError);
    });
    setIsRecording(false);
  }, []);

  const unsupportedControl = useCallback((): void => {
    setError("桌面模式暂不支持暂停或手动刷新，请停止后重新开始。");
  }, []);

  return {
    isDesktop,
    isRecording,
    isPaused: false,
    micLevel: 0,
    retryCount: 0,
    error,
    transcriptChunks,
    setTranscriptChunks,
    audioSourceMode,
    setAudioSourceMode,
    startRecording,
    stopRecording,
    pauseRecording: unsupportedControl,
    resumeRecording: unsupportedControl,
    flushCurrentChunk: unsupportedControl,
    latencySamples,
    pipelineEvents,
  };
}

function compareChunks(left: TranscriptChunk, right: TranscriptChunk): number {
  const leftStart = left.startMs ?? left.timestamp.getTime();
  const rightStart = right.startMs ?? right.timestamp.getTime();
  return leftStart - rightStart || left.timestamp.getTime() - right.timestamp.getTime();
}

function isTranscribePayload(value: unknown): value is {
  text: string;
  latencyMs: number;
  audioDurationMs: number | null;
  realTimeFactor: number | null;
} {
  return isRecord(value)
    && typeof value.text === "string"
    && typeof value.latencyMs === "number"
    && (value.audioDurationMs === null || typeof value.audioDurationMs === "number")
    && (value.realTimeFactor === null || typeof value.realTimeFactor === "number");
}

function isErrorPayload(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
