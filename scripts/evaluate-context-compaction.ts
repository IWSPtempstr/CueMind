import { estimateContextTokens, fallbackTrimAskHistory, compactAskHistory, type AskHistoryEntry } from "@/lib/realtime-context-memory";
const history: AskHistoryEntry[] = Array.from({ length: 12 }, (_, i) => ({ question: `question-${i}`, answer: `answer-${i}`, cardIds: [`card-${i}`], decisionIds: [`decision-${i}`], sourceUrls: [`https://example.com/${i}`] }));
const original = history.map((item) => `${item.question}\n${item.answer}`).join("\n");
const rows = [
  { strategy: "none", originalChars: original.length, compactedChars: original.length, originalTokens: estimateContextTokens(original), compactedTokens: estimateContextTokens(original) },
  ...(["token_trim", "structured_summary"] as const).map((strategy) => { const compacted = strategy === "token_trim" ? fallbackTrimAskHistory(history, 240) : compactAskHistory(history, 240); const text = compacted.map((item) => `${item.question}\n${item.answer}`).join("\n"); return { strategy, originalChars: original.length, compactedChars: text.length, originalTokens: estimateContextTokens(original), compactedTokens: estimateContextTokens(text) }; }),
];
console.log(JSON.stringify({ runId: "context-compaction-20260901", rows, evidenceBoundary: "deterministic local strategy comparison; no production quality claim" }, null, 2));
