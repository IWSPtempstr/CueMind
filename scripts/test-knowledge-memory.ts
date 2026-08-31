import assert from "node:assert/strict";
import {
  buildMemoryAliasKeys,
  isMemoryRecordEligible,
  normalizeMemoryKey,
  type KnowledgeCardRecord,
  type MeetingDecisionRecord,
} from "@/lib/knowledge-memory";

const card: KnowledgeCardRecord = {
  id: "card-kv-cache",
  kind: "knowledge_card",
  keyword: "KV Cache",
  aliases: ["键值缓存", "kv-cache", "KV  Cache"],
  explanation: "保存已计算的键和值，减少重复计算。",
  keyPoints: ["降低重复计算"],
  sourceUrls: ["https://example.test/kv-cache"],
  originMeeting: "meeting-1",
  evidenceChunkIds: ["chunk-1"],
  status: "active",
  validUntil: null,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
};

const decision: MeetingDecisionRecord = {
  id: "decision-1",
  kind: "meeting_decision",
  decision: "采用 Q4 量化方案",
  scope: "本地模型部署",
  originMeeting: "meeting-1",
  evidenceChunkIds: ["chunk-2"],
  decidedAt: "2026-08-30T10:10:00.000Z",
  validUntil: "2026-12-31T00:00:00.000Z",
  status: "active",
  createdAt: "2026-08-30T10:10:00.000Z",
  updatedAt: "2026-08-30T10:10:00.000Z",
};

function run(): void {
  // Unicode NFKC、大小写折叠，以及空白/不同 Unicode 连字符统一为同一 key。
  assert.equal(normalizeMemoryKey("  ＫＶ　—  Cache  "), "kv-cache");
  assert.equal(normalizeMemoryKey("KV cache"), "kv-cache");
  assert.equal(normalizeMemoryKey("KV\tcache"), "kv-cache");
  assert.equal(normalizeMemoryKey(""), "");
  assert.equal(normalizeMemoryKey("   \n\t"), "");

  // canonical keyword 总是参与 key 集合；空 alias、大小写和重复项被去掉。
  assert.deepEqual(buildMemoryAliasKeys("KV Cache", ["键值缓存", "kv-cache", " KV  Cache ", ""]), [
    "kv-cache",
    "键值缓存",
  ]);
  assert.deepEqual(buildMemoryAliasKeys("", ["  ", "别名"]), ["别名"]);

  const now = new Date("2026-08-31T00:00:00.000Z");
  assert.equal(isMemoryRecordEligible(card, now), true, "active + 无有效期应可复用");
  assert.equal(isMemoryRecordEligible(decision, now), true, "active + 未来有效期应可复用");
  assert.equal(
    isMemoryRecordEligible({ ...card, status: "superseded" }, now),
    false,
    "superseded 不得作为当前知识注入",
  );
  assert.equal(
    isMemoryRecordEligible({ ...card, status: "disputed" }, now),
    false,
    "disputed 不得作为当前知识注入",
  );
  assert.equal(
    isMemoryRecordEligible({ ...card, status: "archived" }, now),
    false,
    "archived 不得作为当前知识注入",
  );
  assert.equal(
    isMemoryRecordEligible({ ...decision, validUntil: "2026-08-30T23:59:59.999Z" }, now),
    false,
    "validUntil 已过期不得作为当前决定",
  );
  assert.equal(
    isMemoryRecordEligible({ ...decision, validUntil: "not-a-date" }, now),
    false,
    "无效有效期按不可复用处理（fail closed）",
  );
  assert.equal(
    isMemoryRecordEligible({ ...decision, validUntil: "   " }, now),
    false,
    "显式空白有效期按不可复用处理（fail closed）",
  );
  assert.equal(
    isMemoryRecordEligible({ ...decision, validUntil: "2026-08-31T00:00:00.000Z" }, now),
    true,
    "有效期边界包含截止时刻",
  );

  console.log("knowledge-memory contract tests passed");
}

run();
