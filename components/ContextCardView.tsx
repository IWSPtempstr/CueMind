// Context card rendering: keyword headline, key points, why-now, and the
// source block with per-type badges. Shared by the middle-column
// ContextCardsPanel, the replay page, and the ask-answer source list.

import { useState, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import type { ContextCard, Suggestion } from "@/types/suggestions";

interface ContextCardProps {
  card: ContextCard;
  /** M3-a：沉淀到 vault（fire-and-forget 导出 cuemind/concepts/<term>.md）。 */
  onDeposit?: (card: ContextCard) => void;
  isDeposited?: boolean;
}

/** 建议类别色板（批次三：左栏转写内联徽标沿用；五类全映射）。 */
export function typeBadgeClasses(type: Suggestion["type"]): string {
  switch (type) {
    case "question":
      return "bg-blue-900 text-blue-300";
    case "talking_point":
      return "bg-purple-900 text-purple-300";
    case "answer":
      return "bg-green-900 text-green-300";
    case "fact_check":
      return "bg-yellow-900 text-yellow-300";
    case "clarify":
      return "bg-orange-900 text-orange-300";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** 建议类别文案：问题/观点/回答/核查/澄清。 */
export function typeLabel(type: Suggestion["type"]): string {
  return { question: "问题", talking_point: "观点", answer: "回答", fact_check: "核查", clarify: "澄清" }[type];
}

export function sourceBadge(sourceType: ContextCard["sources"][number]["sourceType"] | string | undefined): string {
  switch (sourceType) {
    case "arxiv":
      return "📄 论文";
    case "hackernews":
      return "💬 HN";
    case "github":
      return "📦 仓库";
    case "stackoverflow":
      return "❓ 问答";
    default:
      return "🌐 网页";
  }
}

export default function ContextCardView({ card, onDeposit, isDeposited }: ContextCardProps): ReactElement {
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  const toggleSource = (url: string): void => {
    setExpandedSources((previous) => {
      const next = new Set(previous);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  return (
    <article className="rounded-lg border border-blue-800/70 bg-blue-950/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-blue-100">{card.keyword}</h3>
        <span className="shrink-0 rounded border border-blue-800 px-2 py-0.5 text-[10px] text-blue-300">
          {card.latencyMs.total}ms
        </span>
      </div>
      {card.keyPoints && card.keyPoints.length > 0 ? (
        <div className="prose prose-sm prose-invert mt-2 max-w-none text-sm text-neutral-200">
          <ReactMarkdown>{card.keyPoints.map((point) => `- ${point}`).join("\n")}</ReactMarkdown>
        </div>
      ) : card.explanation ? (
        <p className="mt-2 text-sm leading-relaxed text-neutral-200">{card.explanation}</p>
      ) : null}
      <div className="mt-3 border-t border-blue-900/60 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">为什么现在相关</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">{card.whyNow}</p>
      </div>
      <div className="mt-3 flex flex-col gap-1.5 border-t border-blue-900/60 pt-3">
        {card.sources.map((source) => (
          <div key={source.url} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-blue-300 underline decoration-blue-900 underline-offset-2 hover:text-blue-200"
              >
                <span className="shrink-0 rounded border border-blue-800 px-1 py-0.5 text-[10px] text-blue-300">
                  {sourceBadge(source.sourceType)}
                </span>
                <span className="truncate">{source.title}</span>
              </a>
              <button
                type="button"
                aria-expanded={expandedSources.has(source.url)}
                onClick={() => toggleSource(source.url)}
                className="shrink-0 rounded border border-blue-900 px-1.5 py-0.5 text-[10px] text-blue-300 hover:bg-blue-950"
              >
                {expandedSources.has(source.url) ? "▾ 收起" : "▸ 证据"}
              </button>
            </div>
            {expandedSources.has(source.url) && source.snippet ? (
              <p className="line-clamp-4 text-[11px] leading-relaxed text-neutral-400">{source.snippet}</p>
            ) : null}
          </div>
        ))}
      </div>
      {onDeposit ? (
        <div className="mt-3 border-t border-blue-900/60 pt-3">
          <button
            type="button"
            disabled={isDeposited}
            aria-label={isDeposited ? "已沉淀到 vault" : "沉淀概念卡片到 vault"}
            onClick={() => onDeposit(card)}
            className={`rounded border border-blue-800 px-2 py-1 text-[10px] text-blue-300 transition-colors hover:bg-blue-950 disabled:opacity-50 disabled:hover:bg-transparent ${isDeposited ? "text-blue-400" : ""}`}
          >
            {isDeposited ? "✓ 已沉淀" : "✨ 沉淀"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
