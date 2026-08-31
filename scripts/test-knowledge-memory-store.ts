import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getKnowledgeMemoryStore, resetKnowledgeMemoryStoreForTests } from "@/lib/knowledge-memory-store";
import type { KnowledgeCardRecord, MeetingDecisionRecord } from "@/lib/knowledge-memory";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-memory-store-"));
if (process.env.TEST_MEMORY_BACKEND === "jsonl") process.env.CUEMIND_KNOWLEDGE_MEMORY_STORE = "jsonl";
resetKnowledgeMemoryStoreForTests();

const card: KnowledgeCardRecord = {
  id: "card-kv-cache",
  kind: "knowledge_card",
  keyword: "KV Cache",
  aliases: ["键值缓存", "kv-cache"],
  explanation: "复用已计算的键和值，减少重复计算。",
  keyPoints: ["适合长序列推理"],
  originMeeting: "meeting-1",
  status: "active",
  validUntil: null,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
};
const decision: MeetingDecisionRecord = {
  id: "decision-q4",
  kind: "meeting_decision",
  decision: "采用 Q4 量化方案",
  scope: "本地模型部署",
  originMeeting: "meeting-1",
  status: "active",
  validUntil: "2026-12-31T00:00:00.000Z",
  decidedAt: "2026-08-30T10:10:00.000Z",
  createdAt: "2026-08-30T10:10:00.000Z",
  updatedAt: "2026-08-30T10:10:00.000Z",
};

const store = getKnowledgeMemoryStore();
store.upsert([card, decision]);
store.upsert([{ ...card, explanation: "更新后的解释" }]);
assert.equal(store.count(), 2, "upsert must remain idempotent");
assert.equal(store.search({ query: "kv-cache" })[0]?.matchedBy, "exact");
assert.equal(store.search({ query: "键值缓存" })[0]?.matchedBy, "alias");
assert.equal(store.search({ query: "长序列推理" })[0]?.matchedBy, "fts");
assert.equal(store.search({ query: "Q4 量化", kind: "meeting_decision" })[0]?.kind, "meeting_decision");
assert.equal(store.search({ query: "Q4 量化", at: "2027-01-01T00:00:00.000Z" }).length, 0, "expired decision must be hidden");
store.upsert([{ ...decision, status: "superseded" }]);
assert.equal(store.search({ query: "Q4 量化" }).length, 0, "superseded decision must be hidden");
assert.equal(store.search({ query: "   " }).length, 0);
store.clear();
assert.equal(store.count(), 0, "derived index clear must remove stale records");
console.log(`knowledge-memory store tests passed (${store.backend})`);
