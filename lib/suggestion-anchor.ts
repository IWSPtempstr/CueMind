// Anchor contract for inline suggestion annotations (live-ask plan batch 3).
// Suggestions carry an `anchor` — a short verbatim substring of the recent
// transcript — which locates the transcript chunk the suggestion refers to.
// Suggestions whose anchor cannot be validated or matched are dropped
// (宁缺毋滥): both functions are pure so tests and the render layer share
// one source of truth.

import type { TranscriptChunk } from "@/types/session";
import type { Suggestion } from "@/types/suggestions";

/** 契约上限：锚点是近期转写原文中的连续子串，≤12 字。 */
export const SUGGESTION_ANCHOR_MAX_CHARS = 12;
/** 二级分词降级：参与匹配的词最短长度（码点）。 */
export const SUGGESTION_ANCHOR_MIN_TOKEN_CHARS = 2;

/**
 * Schema 校验：anchor 必填字符串；去空白后为空 → null（调用方丢弃该建议）；
 * 超过 12 字截断保留前 12。
 */
export function normalizeSuggestionAnchor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > SUGGESTION_ANCHOR_MAX_CHARS
    ? trimmed.slice(0, SUGGESTION_ANCHOR_MAX_CHARS)
    : trimmed;
}

/** 按空白/标点分词，仅保留 ≥2 字的词（二级降级策略的候选词）。 */
function anchorTokens(anchor: string): string[] {
  return anchor
    .split(/[\s，。、；：！？…,.:;!?"'"'()（）[\]【】]+/)
    .map((token) => token.trim())
    .filter((token) => Array.from(token).length >= SUGGESTION_ANCHOR_MIN_TOKEN_CHARS);
}

/**
 * 锚点命中匹配：大小写不敏感子串匹配，按时间序取首个命中的 chunk。
 * 一级策略失败后走二级降级（计划允许）：锚点按空白/标点分词后任一词（≥2 字）
 * 命中即算命中。未命中返回 null → 渲染层丢弃该建议。
 */
export function matchSuggestionAnchor(
  suggestion: Pick<Suggestion, "anchor">,
  chunks: readonly TranscriptChunk[],
): { chunkId: string } | null {
  const anchor = normalizeSuggestionAnchor(suggestion.anchor);
  if (anchor === null) return null;

  // 一级：整串大小写不敏感子串匹配。
  const needle = anchor.toLowerCase();
  for (const chunk of chunks) {
    if (chunk.text.toLowerCase().includes(needle)) return { chunkId: chunk.id };
  }

  // 二级（降级路径）：分词后任一词命中，仍按时间序取首个命中 chunk。
  const tokens = anchorTokens(anchor).map((token) => token.toLowerCase());
  if (tokens.length === 0) return null;
  for (const chunk of chunks) {
    const haystack = chunk.text.toLowerCase();
    if (tokens.some((token) => haystack.includes(token))) return { chunkId: chunk.id };
  }
  return null;
}
