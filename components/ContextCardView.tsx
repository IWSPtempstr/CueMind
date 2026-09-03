// Context card rendering: keyword headline, key points, why-now, and the
// source block with per-type badges. Shared by the middle-column
// ContextCardsPanel, the replay page, and the ask-answer source list.

import { useState, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import type { ContextCard, Suggestion } from "@/types/suggestions";

/** Phase B：卡片存入知识库前的最小可编辑草稿（确认后由父级 POST /api/knowledge）。 */
export interface CardKnowledgeDraft {
  title: string;
  summary: string;
  content: string;
}

interface ContextCardProps {
  card: ContextCard;
  /** M3-a：沉淀到 vault（fire-and-forget 导出 cuemind/concepts/<term>.md）。 */
  onDeposit?: (card: ContextCard) => void;
  isDeposited?: boolean;
  /** B 阶段：卡片「问更多」——术语经 termHint 预填右栏询问框并聚焦。 */
  onAskMore?: (term: string) => void;
  onMarkUseful?: (card: ContextCard) => void;
  isMarkedUseful?: boolean;
  /** Phase B：存入知识库（用户确认并最小编辑后提交）。 */
  onSaveKnowledge?: (card: ContextCard, draft: CardKnowledgeDraft) => void;
  isKnowledgeSaved?: boolean;
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

export default function ContextCardView({ card, onDeposit, isDeposited, onAskMore, onMarkUseful, isMarkedUseful, onSaveKnowledge, isKnowledgeSaved }: ContextCardProps): ReactElement {
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  // Phase B：存知识库的确认/最小编辑表单（默认预填卡片内容，用户可直接提交）。
  const [showKnowledgeForm, setShowKnowledgeForm] = useState(false);
  const [knowledgeDraft, setKnowledgeDraft] = useState<CardKnowledgeDraft>({ title: "", summary: "", content: "" });

  const toggleKnowledgeForm = (): void => {
    if (!showKnowledgeForm) {
      setKnowledgeDraft({
        title: card.keyword,
        summary: card.keyPoints?.[0] ?? card.explanation?.slice(0, 200) ?? "",
        content: card.keyPoints ? card.keyPoints.map((point) => `- ${point}`).join("\n") : card.explanation ?? "",
      });
    }
    setShowKnowledgeForm((previous) => !previous);
  };

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
      {onSaveKnowledge && !isKnowledgeSaved && showKnowledgeForm ? (
        <form
          className="mt-3 flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-950/60 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveKnowledge(card, knowledgeDraft);
            setShowKnowledgeForm(false);
          }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">存入知识库（可先最小编辑）</p>
          <input
            value={knowledgeDraft.title}
            onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })}
            aria-label="知识条目标题"
            placeholder="标题"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
          />
          <input
            value={knowledgeDraft.summary}
            onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, summary: event.target.value })}
            aria-label="知识条目摘要"
            placeholder="摘要"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
          />
          <textarea
            value={knowledgeDraft.content}
            onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, content: event.target.value })}
            aria-label="知识条目内容"
            placeholder="内容"
            rows={4}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs leading-relaxed text-neutral-200"
          />
          <div className="flex gap-2">
            <button type="submit" className="rounded bg-blue-600 px-2 py-1 text-[10px] text-white">确认存入</button>
            <button type="button" onClick={() => setShowKnowledgeForm(false)} className="rounded border border-neutral-700 px-2 py-1 text-[10px] text-neutral-400">取消</button>
          </div>
        </form>
      ) : null}
      {onAskMore || onDeposit || onMarkUseful || onSaveKnowledge ? (
        <div className="mt-3 flex items-center gap-2 border-t border-blue-900/60 pt-3">
          {onAskMore ? (
            <button
              type="button"
              aria-label={`对「${card.keyword}」进一步询问`}
              onClick={() => onAskMore(card.keyword)}
              className="rounded border border-blue-800 px-2 py-1 text-[10px] text-blue-300 transition-colors hover:bg-blue-950"
            >
              💬 问更多
            </button>
          ) : null}
          {onMarkUseful ? <button type="button" onClick={() => onMarkUseful(card)} disabled={isMarkedUseful} className="rounded border border-amber-800 px-2 py-1 text-[10px] text-amber-300 disabled:opacity-50">{isMarkedUseful ? "已标记应出卡" : "标记应出卡"}</button> : null}
          {onSaveKnowledge ? (
            <button
              type="button"
              disabled={isKnowledgeSaved}
              aria-label={isKnowledgeSaved ? "已存入知识库" : "存入知识库"}
              onClick={toggleKnowledgeForm}
              className={`rounded border border-emerald-800 px-2 py-1 text-[10px] text-emerald-300 transition-colors hover:bg-emerald-950 disabled:opacity-50 ${isKnowledgeSaved ? "text-emerald-500" : ""}`}
            >
              {isKnowledgeSaved ? "✓ 已存知识库" : "📚 存知识库"}
            </button>
          ) : null}
          {onDeposit ? (
            <button
              type="button"
              disabled={isDeposited}
              aria-label={isDeposited ? "已沉淀到 vault" : "沉淀概念卡片到 vault"}
              onClick={() => onDeposit(card)}
              className={`rounded border border-blue-800 px-2 py-1 text-[10px] text-blue-300 transition-colors hover:bg-blue-950 disabled:opacity-50 disabled:hover:bg-transparent ${isDeposited ? "text-blue-400" : ""}`}
            >
              {isDeposited ? "✓ 已沉淀" : "✨ 沉淀"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
