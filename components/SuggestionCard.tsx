// One tappable suggestion tile: type chip, preview line, dimmed when not in the newest batch.

import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import type { Suggestion } from "@/types/suggestions";
import type { SuggestionFeedback } from "@/hooks/useSuggestions";

interface SuggestionCardProps {
  suggestion: Suggestion;
  onSelect: (suggestion: Suggestion) => void;
  isLatestBatch: boolean;
  isPinned: boolean;
  onFeedback: (suggestion: Suggestion, feedback: SuggestionFeedback) => void;
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
        {suggestion.type.replaceAll("_", " ")}
      </span>
      <p className="mt-2 text-sm text-white">{suggestion.preview}</p>
      <div className="mt-3 flex gap-3 border-t border-neutral-800 pt-2 text-xs text-neutral-500">
        <button type="button" aria-label={isPinned ? "Unpin suggestion" : "Pin suggestion"} onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "pin"); }} className={isPinned ? "text-blue-300" : "hover:text-white"}>{isPinned ? "★ Pinned" : "☆ Pin"}</button>
        <button type="button" aria-label="Dismiss suggestion" onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "dismiss"); }} className="hover:text-white">Dismiss</button>
        <button type="button" aria-label="Mark suggestion unhelpful" onClick={(event) => { event.stopPropagation(); onFeedback(suggestion, "down"); }} className="hover:text-white">👎</button>
        <button type="button" aria-label="Copy suggestion details" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(`${suggestion.preview}\n\n${suggestion.detail}`); }} className="ml-auto hover:text-white">Copy</button>
      </div>
    </div>
  );
}
