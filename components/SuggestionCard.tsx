// One tappable suggestion tile: type chip, preview line, dimmed when not in the newest batch.

import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import type { ContextCard, Suggestion } from "@/types/suggestions";
import type { SuggestionFeedback } from "@/hooks/useSuggestions";

interface SuggestionCardProps {
  suggestion: Suggestion;
  onSelect: (suggestion: Suggestion) => void;
  isLatestBatch: boolean;
  isPinned: boolean;
  onFeedback: (suggestion: Suggestion, feedback: SuggestionFeedback) => void;
}

interface ContextCardProps {
  card: ContextCard;
}

function typeBadgeClasses(type: Suggestion["type"]): string {
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

function typeLabel(type: Suggestion["type"]): string {
  return { question: "问题", talking_point: "观点", answer: "回答", fact_check: "核查", clarify: "澄清" }[type];
}

export default function SuggestionCard({
  suggestion,
  onSelect,
  isLatestBatch,
  isPinned,
  onFeedback,
}: SuggestionCardProps): ReactElement {
  const dimmed = !isLatestBatch ? "opacity-50" : "";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(suggestion);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelect(suggestion);
      }}
      onKeyDown={handleKeyDown}
      aria-label={`${suggestion.type}: ${suggestion.preview}`}
      className={`w-full cursor-pointer rounded-lg border border-neutral-700 bg-neutral-900/50 p-4 text-left transition-colors hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500 ${dimmed}`}
    >
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium uppercase ${typeBadgeClasses(suggestion.type)}`}
      >
        {typeLabel(suggestion.type)}
      </span>
      <p className="mt-2 text-sm text-white">{suggestion.preview}</p>
      <div className="mt-3 flex gap-3 border-t border-neutral-800 pt-2 text-xs text-neutral-500">
        <button type="button" aria-label={isPinned ? "取消置顶建议" : "置顶建议"} onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "pin"); }} className={isPinned ? "text-blue-300" : "hover:text-white"}>{isPinned ? "★ 已置顶" : "☆ 置顶"}</button>
        <button type="button" aria-label="忽略建议" onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "dismiss"); }} className="hover:text-white">忽略</button>
        <button type="button" aria-label="标记建议无帮助" onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "down"); }} className="hover:text-white">👎</button>
        <button type="button" aria-label="复制建议详情" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(`${suggestion.preview}\n\n${suggestion.detail}`); }} className="ml-auto hover:text-white">复制</button>
      </div>
    </div>
  );
}

export function ContextCardView({ card }: ContextCardProps): ReactElement {
  return (
    <article className="rounded-lg border border-blue-800/70 bg-blue-950/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-blue-100">{card.keyword}</h3>
        <span className="shrink-0 rounded border border-blue-800 px-2 py-0.5 text-[10px] text-blue-300">
          {card.latencyMs.total}ms
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-neutral-200">{card.explanation}</p>
      <div className="mt-3 border-t border-blue-900/60 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">为什么现在相关</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">{card.whyNow}</p>
      </div>
      <div className="mt-3 flex flex-col gap-1.5 border-t border-blue-900/60 pt-3">
        {card.sources.map((source) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-xs text-blue-300 underline decoration-blue-900 underline-offset-2 hover:text-blue-200"
          >
            {source.title}
          </a>
        ))}
      </div>
    </article>
  );
}
