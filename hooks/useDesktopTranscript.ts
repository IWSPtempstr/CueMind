"use client";

import { useCallback, useEffect, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
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

  useEffect(() => {
    setIsDesktop(Boolean(window.cuemindDesktop));
  }, []);

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

  useEffect(() => {
    const bridge = window.cuemindDesktop;
    if (!bridge) return;

    return bridge.onRuntimeEvent((raw) => {
      const event = parseDesktopEvent(raw);
      if (!event) return;
      if (event.type === "runtime_error") {
        setError(event.message);
      } else if (event.type === "audio_chunk_ready") {
        void transcribeChunk(event);
      }
    });
  }, [transcribeChunk]);

  const startRecording = useCallback(async (): Promise<void> => {
    const bridge = window.cuemindDesktop;
    if (!bridge) {
      setError("桌面运行时不可用，将继续使用浏览器录音。");
      return;
    }
    const status = await bridge.startAudioHelper();
    if (status.lastError) {
      setError(status.lastError);
      return;
    }
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

function isTranscribePayload(value: unknown): value is { text: string; latencyMs: number } {
  return isRecord(value) && typeof value.text === "string" && typeof value.latencyMs === "number";
}

function isErrorPayload(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
