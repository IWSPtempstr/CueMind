"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { AudioSourceMode } from "@/lib/audio-source-mode";
import { parseDesktopEvent, type AudioChunkReadyEvent } from "@/lib/desktop-events";
import type { LatencySample } from "@/lib/telemetry";
import type { TranscriptChunk } from "@/types/session";

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
}

export default function useDesktopTranscript(): UseDesktopTranscriptResult {
  const [isDesktop, setIsDesktop] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptChunks, setTranscriptState] = useState<TranscriptChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [audioSourceMode, setAudioSourceModeState] = useState<AudioSourceMode>("mixed");
  const queueRef = useRef<AudioChunkReadyEvent[]>([]);
  const processingRef = useRef(false);
  const seenChunkIdsRef = useRef(new Set<string>());
  const audioSourceModeRef = useRef<AudioSourceMode>("mixed");
  // 已同步到主进程的输入源模式；startRecording 前据此判断是否需要先同步。
  const appliedAudioSourceModeRef = useRef<AudioSourceMode>("mixed");

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
    const settings = loadCueMindSettings();
    if (!settings.localWhisperPath.trim() || !settings.localWhisperModelPath.trim()) {
      setError("请先在设置中填写 whisper.cpp 可执行文件和模型路径。");
      return;
    }

    const asrStartedAt = new Date();
    try {
      const response = await fetch("/api/local-transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioPath: event.path,
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
      if (!payload.text.trim()) return;

      const asrEndedAt = new Date();
      setLatencySamples((previous) => [
        ...previous,
        { id: crypto.randomUUID(), stage: "capture", durationMs: Math.max(0, event.endMs - event.startMs), createdAt: new Date() },
        { id: crypto.randomUUID(), stage: "asr", durationMs: payload.latencyMs, createdAt: asrEndedAt },
      ]);
      setTranscriptState((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          text: payload.text.trim(),
          timestamp: new Date(event.startedAt),
          source: event.source,
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
      setError(caught instanceof Error ? caught.message : "本地转写失败");
    }
  }, []);

  const enqueueChunk = useCallback((event: AudioChunkReadyEvent): void => {
    if (seenChunkIdsRef.current.has(event.id)) return;
    seenChunkIdsRef.current.add(event.id);
    if (queueRef.current.length >= 3) {
      queueRef.current.shift();
      setError("本地转写队列已满，已丢弃最旧的待处理音频片段。");
    }
    queueRef.current.push(event);
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
