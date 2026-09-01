export interface TranscriptWindow { id: string; text: string; timestampMs: number }
export interface CardContextState { recentTranscript: string; shownKeywords: string[]; currentTopics: string[]; unresolvedTopics: string[] }
export interface AskContextSummary { topics: string[]; answeredQuestions: string[]; unresolvedQuestions: string[]; referencedCardIds: string[]; referencedDecisionIds: string[]; referencedSourceUrls: string[]; summaryVersion: string }
export interface CompressionMetrics { originalChars: number; compactedChars: number; originalTokens: number; compactedTokens: number; trigger: "token_threshold" | "ask_turn_count" | "meeting_duration" | "manual"; status: "ok" | "fallback" | "failed" }
export interface ContextSummaryRecord { sessionId: string; summary: AskContextSummary; metrics: CompressionMetrics; updatedAt: string; }
export interface AskHistoryEntry { question: string; answer: string; cardIds?: string[]; decisionIds?: string[]; sourceUrls?: string[] }
export interface AskContext { currentQuestion: string; recentTranscript: string; recentTurns: AskHistoryEntry[]; summary: AskContextSummary; evidence: string[] }

export function buildCardContext(chunks: readonly TranscriptWindow[], shownKeywords: readonly string[], currentTopics: readonly string[], unresolvedTopics: readonly string[], windowMs = 60_000): CardContextState {
  const now = chunks.at(-1)?.timestampMs ?? 0;
  const bounded = chunks.filter((chunk) => now - chunk.timestampMs <= windowMs).slice(-8);
  return { recentTranscript: bounded.map((chunk) => chunk.text).join("\n"), shownKeywords: [...shownKeywords], currentTopics: [...currentTopics], unresolvedTopics: [...unresolvedTopics] };
}

export function buildAskContext(currentQuestion: string, chunks: readonly TranscriptWindow[], history: readonly AskHistoryEntry[], summary: AskContextSummary, evidence: readonly string[]): AskContext {
  return { currentQuestion, recentTranscript: chunks.slice(-8).map((chunk) => chunk.text).join("\n"), recentTurns: history.slice(-4).map((turn) => ({ ...turn })), summary: { ...summary }, evidence: [...evidence].slice(-3) };
}

export function estimateContextTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }
export function shouldCompact(promptTokens: number, contextWindowTokens: number, askTurns: number, meetingDurationMs: number): boolean { return promptTokens >= contextWindowTokens * 0.6 || askTurns >= 5 || meetingDurationMs >= 10 * 60 * 1000; }
export function chooseCompressionTrigger(input: { promptTokens: number; contextWindowTokens: number; askTurns: number; meetingDurationMs: number; manual?: boolean }): CompressionMetrics["trigger"] | null { if (input.manual) return "manual"; if (input.promptTokens >= input.contextWindowTokens * 0.6) return "token_threshold"; if (input.askTurns >= 5) return "ask_turn_count"; if (input.meetingDurationMs >= 10 * 60 * 1000) return "meeting_duration"; return null; }
export function compactAskHistory(history: readonly AskHistoryEntry[], maxChars: number): AskHistoryEntry[] { return trimHistory(history, maxChars); }
export function fallbackTrimAskHistory(history: readonly AskHistoryEntry[], maxChars: number): AskHistoryEntry[] { return trimHistory(history, maxChars); }
export function validateAskContextSummary(summary: unknown): summary is AskContextSummary {
  if (!isRecord(summary) || typeof summary.summaryVersion !== "string") return false;
  return ["topics", "answeredQuestions", "unresolvedQuestions", "referencedCardIds", "referencedDecisionIds", "referencedSourceUrls"].every((key) => Array.isArray(summary[key]) && (summary[key] as unknown[]).every((item) => typeof item === "string"));
}
export function createContextSummaryRecord(sessionId: string, summary: AskContextSummary, metrics: CompressionMetrics): ContextSummaryRecord { if (!sessionId.trim() || !validateAskContextSummary(summary)) throw new Error("invalid context summary"); return { sessionId: sessionId.trim(), summary: { ...summary }, metrics: { ...metrics }, updatedAt: new Date().toISOString() }; }
function trimHistory(history: readonly AskHistoryEntry[], maxChars: number): AskHistoryEntry[] { const result: AskHistoryEntry[] = []; let size = 0; for (let i = history.length - 1; i >= 0; i -= 1) { const item = history[i]; const itemSize = item.question.length + item.answer.length; if (result.length > 0 && size + itemSize > maxChars) break; result.unshift({ ...item }); size += itemSize; } return result; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
