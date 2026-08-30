"use client";

// Middle column (decision 68): context cards only — card list (ContextCardView
// reused) plus failure/degraded states. Suggestion cards moved out for good.

import { type ReactElement } from "react";
import ContextCardView from "@/components/ContextCardView";
import type { ContextCard, ContextCardFailure } from "@/types/suggestions";

interface ContextCardsPanelProps {
  cards: ContextCard[];
  failures: ContextCardFailure[];
  isLoading: boolean;
  error: string | null;
  /** M3-a：卡片沉淀到 vault（fire-and-forget）。 */
  onCardDeposit?: (card: ContextCard) => void;
  depositedCardIds?: ReadonlySet<string>;
  /** B 阶段：卡片「问更多」→ termHint 预填右栏询问框。 */
  onAskMore?: (term: string) => void;
  onMarkUseful?: (card: ContextCard) => void;
  usefulCandidateIds?: ReadonlySet<string>;
}

export default function ContextCardsPanel({
  cards,
  failures,
  isLoading,
  error,
  onCardDeposit,
  depositedCardIds,
  onAskMore,
  onMarkUseful,
  usefulCandidateIds,
}: ContextCardsPanelProps): ReactElement {
  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col border-r border-neutral-800 lg:h-auto lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">2. 上下文卡片</h2>
        <span className="rounded-full border border-neutral-700 px-2.5 py-1 text-[10px] font-semibold text-neutral-400">
          {cards.length} 张
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6">
        {error ? <p className="text-xs text-red-500">{error}</p> : null}
        {isLoading ? <p className="animate-pulse text-xs text-blue-300">正在检索并整理关键词背景...</p> : null}
        {cards.length > 0 ? (
          <section className="flex min-w-0 flex-col gap-3" aria-live="polite" aria-atomic="false">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">CONTEXT CARDS</h3>
              <span className="text-[10px] text-neutral-600">本地模型 + Web 来源</span>
            </div>
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-blue-200">当前背景</p>
              <ContextCardView card={cards[0]} onDeposit={onCardDeposit} isDeposited={depositedCardIds?.has(cards[0].candidateId) ?? false} onAskMore={onAskMore} onMarkUseful={onMarkUseful} isMarkedUseful={usefulCandidateIds?.has(cards[0].candidateId)} />
            </div>
            {cards.length > 1 ? (
              <div className="max-h-96 min-w-0 space-y-3 overflow-y-auto pr-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">此前背景 · {cards.length - 1}</p>
                {cards.slice(1).map((card) => <ContextCardView key={card.id} card={card} onDeposit={onCardDeposit} isDeposited={depositedCardIds?.has(card.candidateId) ?? false} onAskMore={onAskMore} onMarkUseful={onMarkUseful} isMarkedUseful={usefulCandidateIds?.has(card.candidateId)} />)}
              </div>
            ) : null}
            <p className="text-[10px] text-neutral-500">来源：每张卡片均附带检索来源。</p>
          </section>
        ) : !isLoading && !error ? (
          <p className="text-center text-sm text-neutral-600">开始录音后，关键词背景卡片会显示在这里。</p>
        ) : null}
        {failures.length > 0 ? (
          <p className="text-xs text-amber-300" aria-live="polite">失败：{failures.length} 次背景卡片未生成，已保留可用内容。</p>
        ) : null}
        {cards.some((card) => card.demoTrace && card.demoTrace.decisionSource !== "model") ? <p className="text-xs text-neutral-500">降级：部分背景卡片使用规则或检索结果。</p> : null}
      </div>
    </section>
  );
}
