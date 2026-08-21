"use client";

import { useEffect, useState, type ReactElement } from "react";
import SuggestionCard, { ContextCardView } from "@/components/SuggestionCard";
import type { SuggestionFeedback } from "@/hooks/useSuggestions";
import type { ContextCard, ContextCardFailure, Suggestion, SuggestionBatch } from "@/types/suggestions";

interface Props {
  batches: SuggestionBatch[];
  isLoading: boolean;
  isRecording: boolean;
  nextRefreshAt: number | null;
  onManualRefresh: () => void;
  error: string | null;
  onSuggestionSelect: (suggestion: Suggestion) => void;
  dismissedIds: ReadonlySet<string>;
  pinnedIds: ReadonlySet<string>;
  onFeedback: (suggestion: Suggestion, feedback: SuggestionFeedback) => void;
  contextCards: ContextCard[];
  contextCardFailures: ContextCardFailure[];
  contextCardsLoading: boolean;
  contextCardsError: string | null;
}

export default function LiveSuggestions(props: Props): ReactElement {
  const { batches, isLoading, isRecording, nextRefreshAt, onManualRefresh, error, onSuggestionSelect, dismissedIds, pinnedIds, onFeedback, contextCards, contextCardFailures, contextCardsLoading, contextCardsError } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isRecording || nextRefreshAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRecording, nextRefreshAt]);
  const seconds = nextRefreshAt === null ? null : Math.max(0, Math.ceil((nextRefreshAt - now) / 1000));

  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col border-r border-neutral-800 lg:h-auto lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">2. 实时建议</h2>
        <span className="rounded-full border border-neutral-700 px-2.5 py-1 text-[10px] font-semibold text-neutral-400">
          {batches.length} 批
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6">
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onManualRefresh} disabled={isLoading} className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 disabled:opacity-40">
            ↺ 刷新建议
          </button>
          <span className="text-xs text-neutral-500">
            {isRecording && seconds !== null ? `${seconds} 秒后自动刷新` : "开始录音后自动刷新"}
          </span>
        </div>
        {error ? <p className="text-xs text-red-500">{error}</p> : null}
        {contextCardsError ? <p className="text-xs text-amber-300">{contextCardsError}</p> : null}
        {contextCardsLoading ? <p className="animate-pulse text-xs text-blue-300">正在检索并整理关键词背景...</p> : null}
        {contextCards.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">CONTEXT CARDS</h3>
              <span className="text-[10px] text-neutral-600">本地模型 + Web 来源</span>
            </div>
            {contextCards.map((card) => <ContextCardView key={card.id} card={card} />)}
          </section>
        ) : null}
        {contextCardFailures.length > 0 ? (
          <details className="rounded border border-neutral-800 bg-neutral-950/70 px-3 py-2 text-xs text-neutral-500">
            <summary className="cursor-pointer">调试记录：{contextCardFailures.length} 次卡片未生成</summary>
            <div className="mt-2 flex flex-col gap-1.5">
              {contextCardFailures.slice(0, 5).map((failure) => (
                <p key={failure.id}>{failure.failedAt.toLocaleTimeString()} · {failure.reason}</p>
              ))}
            </div>
          </details>
        ) : null}
        {isLoading ? <p className="animate-pulse text-center text-sm text-neutral-500">正在生成建议…</p> : null}
        {!isLoading && batches.length === 0 ? <p className="text-center text-sm text-neutral-600">开始录音后，建议会显示在这里。</p> : null}
        <div className="flex flex-col gap-6">
          {batches.map((batch, batchIndex) => {
            const visible = batch.suggestions
              .filter((suggestion) => !suggestion.id || !dismissedIds.has(suggestion.id))
              .sort(
                (a, b) =>
                  Number(Boolean(b.id && pinnedIds.has(b.id))) -
                  Number(Boolean(a.id && pinnedIds.has(a.id))),
              );
            if (visible.length === 0) return null;
            return (
              <section key={batch.id} className="flex flex-col gap-3">
                <time className="text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                  {batch.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </time>
                {visible.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    onSelect={onSuggestionSelect}
                    isLatestBatch={batchIndex === 0}
                    isPinned={Boolean(suggestion.id && pinnedIds.has(suggestion.id))}
                    onFeedback={onFeedback}
                  />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
