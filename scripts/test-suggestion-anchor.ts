// Suggestion anchor regression (plan batch 3, commit 6):
// a) 整串命中（大小写不敏感、时间序首个 chunk 优先）
// b) 未命中 → null（渲染层丢弃语义）
// c) >12 字截断（校验函数）+ 空/缺失丢弃
// d) 二级分词降级（整串失败 → 任一词 ≥2 字命中）
// e) 徽标映射五类齐全（typeLabel / typeBadgeClasses）

import assert from "node:assert/strict";
import { typeBadgeClasses, typeLabel } from "@/components/ContextCardView";
import {
  SUGGESTION_ANCHOR_MAX_CHARS,
  matchSuggestionAnchor,
  normalizeSuggestionAnchor,
} from "@/lib/suggestion-anchor";
import type { TranscriptChunk } from "@/types/session";
import type { Suggestion, SuggestionType } from "@/types/suggestions";

function makeChunk(id: string, text: string, minuteOffset: number): TranscriptChunk {
  return { id, text, timestamp: new Date(Date.UTC(2026, 7, 28, 6, minuteOffset, 0)) };
}

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return { type: "question", preview: "示例建议", detail: "示例详情", ...overrides };
}

const chunks: TranscriptChunk[] = [
  makeChunk("chunk-1", "我们聊聊 Speculative Decoding 对吞吐的提升", 1),
  makeChunk("chunk-2", "speculative 草稿模型的接受率是关键", 2),
  makeChunk("chunk-3", "另外 KV cache 命中率也值得优化", 3),
];

// a) 整串命中：大小写不敏感；多个 chunk 都含锚点时取时间序首个。
function testExactMatchFirstChunkCaseInsensitive(): void {
  const match = matchSuggestionAnchor(makeSuggestion({ anchor: "speculative" }), chunks);
  assert.deepEqual(match, { chunkId: "chunk-1" }, "大小写不敏感 + 时间序首个命中（chunk-1 优先于 chunk-2）");

  const exactCase = matchSuggestionAnchor(makeSuggestion({ anchor: "Speculative Decoding" }), chunks);
  assert.deepEqual(exactCase, { chunkId: "chunk-1" });

  const kv = matchSuggestionAnchor(makeSuggestion({ anchor: "KV cache" }), chunks);
  assert.deepEqual(kv, { chunkId: "chunk-3" });
}

// b) 未命中 → null（渲染层丢弃该建议）。
function testNoMatchReturnsNull(): void {
  assert.equal(matchSuggestionAnchor(makeSuggestion({ anchor: "量子纠缠" }), chunks), null);
  assert.equal(matchSuggestionAnchor(makeSuggestion({ anchor: "" }), chunks), null, "空锚点 → null");
  assert.equal(matchSuggestionAnchor(makeSuggestion({}), chunks), null, "缺失锚点 → null");
  assert.equal(matchSuggestionAnchor(makeSuggestion({ anchor: "   " }), chunks), null, "纯空白锚点 → null");
}

// c) 校验函数：>12 字截断保留前 12；空/缺失/非字符串 → null（丢弃）。
function testAnchorNormalization(): void {
  assert.equal(SUGGESTION_ANCHOR_MAX_CHARS, 12);
  const longAnchor = "一二三四五六七八九十三四五六"; // 14 字
  assert.equal(longAnchor.length, 14);
  assert.equal(normalizeSuggestionAnchor(longAnchor), "一二三四五六七八九十三四", "去空白后 >12 字截断保留前 12");
  assert.equal(normalizeSuggestionAnchor("  前后空白  "), "前后空白", "先去首尾空白");
  assert.equal(normalizeSuggestionAnchor(""), null);
  assert.equal(normalizeSuggestionAnchor("   "), null);
  assert.equal(normalizeSuggestionAnchor(undefined), null);
  assert.equal(normalizeSuggestionAnchor(12345), null, "非字符串 → null（丢弃）");
}

// d) 二级分词降级：整串未命中时，按空白/标点分词后任一词（≥2 字）命中。
function testTokenFallbackSecondTier(): void {
  // 「命中率 cache」整串不在任何 chunk（顺序颠倒），但两个词分别命中 → 降级命中。
  // 时间序首个含任一词的 chunk 是 chunk-1？chunk-1 无「命中率」也无「cache」…
  // chunk-3 含两者 → 命中 chunk-3。
  const reversed = matchSuggestionAnchor(makeSuggestion({ anchor: "命中率 cache" }), chunks);
  assert.deepEqual(reversed, { chunkId: "chunk-3" }, "二级分词降级应命中含词的首个时间序 chunk");

  // 分词需剔除 <2 字碎片：锚点「了 KV」只有「KV」一词可用。
  const withStopword = matchSuggestionAnchor(makeSuggestion({ anchor: "了 KV" }), chunks);
  assert.deepEqual(withStopword, { chunkId: "chunk-3" }, "≥2 字词参与匹配，单字词被剔除");

  // 二级也未命中 → null。
  const noTierMatch = matchSuggestionAnchor(makeSuggestion({ anchor: "不存在 的词" }), chunks);
  assert.equal(noTierMatch, null, "两级策略都未命中 → null");
}

// e) 徽标映射五类齐全：文案 + 色板（沿用旧 typeBadgeClasses 五色）。
function testBadgeMappingsCoverAllFiveTypes(): void {
  const expectedLabels: Record<SuggestionType, string> = {
    question: "问题",
    talking_point: "观点",
    answer: "回答",
    fact_check: "核查",
    clarify: "澄清",
  };
  const expectedColorToken: Record<SuggestionType, string> = {
    question: "blue",
    talking_point: "purple",
    answer: "green",
    fact_check: "yellow",
    clarify: "orange",
  };
  const seen = new Set<string>();
  for (const type of Object.keys(expectedLabels) as SuggestionType[]) {
    assert.equal(typeLabel(type), expectedLabels[type], `typeLabel(${type})`);
    const classes = typeBadgeClasses(type);
    assert.ok(classes.length > 0, `typeBadgeClasses(${type}) 非空`);
    assert.ok(classes.includes(expectedColorToken[type]), `typeBadgeClasses(${type}) 应含 ${expectedColorToken[type]} 色`);
    seen.add(classes);
  }
  assert.equal(seen.size, 5, "五类徽标色板互不相同（五类全映射）");
}

function main(): void {
  testExactMatchFirstChunkCaseInsensitive();
  console.log("a) 整串命中（大小写不敏感 + 首个时间序 chunk）通过");
  testNoMatchReturnsNull();
  console.log("b) 未命中 → null（渲染丢弃语义）通过");
  testAnchorNormalization();
  console.log("c) >12 字截断 + 空/缺失丢弃 通过");
  testTokenFallbackSecondTier();
  console.log("d) 二级分词降级策略 通过");
  testBadgeMappingsCoverAllFiveTypes();
  console.log("e) 徽标映射五类齐全（typeLabel/typeBadgeClasses）通过");
  console.log("suggestion anchor regression tests passed");
}

main();
