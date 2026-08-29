"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import Link from "next/link";
import LatencyPanel from "@/components/LatencyPanel";
import ContextCardView from "@/components/ContextCardView";
import useContextCards from "@/hooks/useContextCards";
import { parseReplayEvents, replayDelayMs } from "@/lib/replay";
import type { DesktopEvent, TranscriptReadyEvent } from "@/lib/desktop-events";
import type { LatencySample } from "@/lib/telemetry";
import type { TranscriptChunk } from "@/types/session";

const speeds = [1, 2, 5] as const;

export default function ReplayPage(): ReactElement {
  const [events, setEvents] = useState<DesktopEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof speeds)[number]>(1);
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const timerRef = useRef<number | null>(null);
  const cursorRef = useRef(0);
  const eventsRef = useRef<DesktopEvent[]>([]);
  const speedRef = useRef(speed);
  const contextCards = useContextCards({ transcriptChunks, isRecording: isPlaying });

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const reset = useCallback((): void => {
    clearTimer();
    setIsPlaying(false);
    cursorRef.current = 0;
    setCursor(0);
    setTranscriptChunks([]);
    setLatencySamples([]);
    setError(null);
  }, [clearTimer]);

  const emitNext = useCallback((): void => {
    const currentCursor = cursorRef.current;
    const currentEvents = eventsRef.current;
    if (currentCursor >= currentEvents.length) {
      setIsPlaying(false);
      return;
    }
    const event = currentEvents[currentCursor];
    if (event.type === "transcript_ready") {
      const chunk = toTranscriptChunk(event);
      setTranscriptChunks((previous) => [...previous, chunk].sort(compareChunks));
      if (typeof event.latencyMs === "number") {
        setLatencySamples((previous) => [
          ...previous,
          { id: crypto.randomUUID(), stage: "asr", durationMs: event.latencyMs!, createdAt: new Date() },
        ]);
      }
    }
    const next = currentEvents[currentCursor + 1];
    cursorRef.current = currentCursor + 1;
    setCursor(cursorRef.current);
    if (!next) {
      setIsPlaying(false);
      return;
    }
    const delay = replayDelayMs(event, next, speedRef.current);
    timerRef.current = window.setTimeout(emitNext, delay);
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      clearTimer();
      return;
    }
    emitNext();
    return clearTimer;
  }, [clearTimer, emitNext, isPlaying]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const loadFile = useCallback(async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseReplayEvents(await file.text());
      if (parsed.length === 0) throw new Error("没有找到有效的桌面事件。");
      reset();
      eventsRef.current = parsed;
      setEvents(parsed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取 replay 文件");
    } finally {
      event.target.value = "";
    }
  }, [reset]);

  const togglePlaying = useCallback((): void => {
    if (events.length === 0) {
      setError("请先加载 JSONL replay 文件。");
      return;
    }
    if (cursorRef.current >= eventsRef.current.length) reset();
    setError(null);
    setIsPlaying((value) => !value);
  }, [events.length, reset]);

  return (
    <main className="min-h-dvh bg-[#0a0a0a] px-4 py-6 text-neutral-200 md:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-600">CueMind</p>
            <h1 className="mt-1 text-xl font-semibold text-neutral-100">Replay Mode</h1>
          </div>
          <Link href="/" className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200">
            返回实时会议
          </Link>
        </header>

        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 p-4">
          <label className="rounded border border-blue-700 bg-blue-950/30 px-3 py-2 text-xs text-blue-200">
            加载 JSONL
            <input type="file" accept=".jsonl,.txt,application/json" onChange={(event) => void loadFile(event)} className="sr-only" />
          </label>
          <button type="button" onClick={togglePlaying} className="rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white">
            {isPlaying ? "暂停" : cursor >= events.length && events.length > 0 ? "重新播放" : "播放"}
          </button>
          <button type="button" onClick={reset} className="rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-400">
            重置
          </button>
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            速度
            <select value={speed} onChange={(event) => { const nextSpeed = Number(event.target.value) as (typeof speeds)[number]; speedRef.current = nextSpeed; setSpeed(nextSpeed); }} className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-200">
              {speeds.map((value) => <option key={value} value={value}>{value}x</option>)}
            </select>
          </label>
          <span className="ml-auto text-xs text-neutral-600">{cursor}/{events.length} events</span>
        </section>

        {error ? <p className="rounded border border-red-900 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p> : null}
        <LatencyPanel samples={[...latencySamples, ...contextCards.latencySamples]} skippedFailures={contextCards.failures.length} />

        <div className="grid min-h-[55vh] grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">转写回放</h2>
              <span className="text-[10px] text-neutral-600">{transcriptChunks.length} chunks</span>
            </div>
            <div className="flex flex-col">
              {transcriptChunks.map((chunk, index) => (
                <article key={chunk.id} className={`py-3 ${index ? "border-t border-neutral-800" : ""}`}>
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-600">
                    <time>{chunk.timestamp.toLocaleTimeString()}</time>
                    <span>{chunk.source === "system" ? "系统音频" : "麦克风"}</span>
                  </div>
                  <p className="text-sm leading-relaxed text-neutral-300">{chunk.text}</p>
                </article>
              ))}
              {transcriptChunks.length === 0 ? <p className="text-sm text-neutral-600">加载 fixture 后开始回放。</p> : null}
            </div>
          </section>
          <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">认知卡片</h2>
              <span className="text-[10px] text-neutral-600">本地模型 + Web 来源</span>
            </div>
            <div className="flex flex-col gap-3">
              {contextCards.cards.map((card) => <ContextCardView key={card.id} card={card} />)}
              {contextCards.isLoading ? <p className="text-xs text-blue-300">正在生成卡片...</p> : null}
              {contextCards.failures.map((failure) => <p key={failure.id} className="text-xs text-neutral-600">跳过：{failure.reason}</p>)}
              {contextCards.cards.length === 0 && contextCards.failures.length === 0 ? <p className="text-sm text-neutral-600">回放过程中自动尝试生成卡片。</p> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function toTranscriptChunk(event: TranscriptReadyEvent): TranscriptChunk {
  const timestamp = new Date(event.timestamp);
  return {
    id: event.id,
    text: event.text,
    timestamp,
    source: event.source,
    startMs: event.startMs,
    endMs: event.endMs,
    latency: typeof event.latencyMs === "number" ? { asrEndedAt: new Date(timestamp.getTime() + event.latencyMs) } : undefined,
  };
}

function compareChunks(left: TranscriptChunk, right: TranscriptChunk): number {
  return (left.startMs ?? 0) - (right.startMs ?? 0);
}
