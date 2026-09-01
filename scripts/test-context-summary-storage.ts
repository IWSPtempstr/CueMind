import assert from "node:assert/strict";
import { createContextSummaryRecord } from "@/lib/realtime-context-memory";
const record = createContextSummaryRecord("session-a", { topics: ["topic"], answeredQuestions: [], unresolvedQuestions: ["open"], referencedCardIds: ["card"], referencedDecisionIds: ["decision"], referencedSourceUrls: ["https://example.com"], summaryVersion: "v1" }, { originalChars: 100, compactedChars: 40, originalTokens: 25, compactedTokens: 10, trigger: "manual", status: "ok" });
assert.equal(record.sessionId, "session-a");
assert.equal(record.metrics.compactedTokens, 10);
assert.equal((record as unknown as Record<string, unknown>).prompt, undefined);
console.log("context summary storage assertions passed");
