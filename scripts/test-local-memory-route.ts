import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/local-memory/route";
import { getKnowledgeMemoryStore, resetKnowledgeMemoryStoreForTests } from "@/lib/knowledge-memory-store";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-local-memory-route-"));
process.env.CUEMIND_KNOWLEDGE_MEMORY_STORE = "jsonl";
resetKnowledgeMemoryStoreForTests();
getKnowledgeMemoryStore().upsert([{
  id: "card-kv",
  kind: "knowledge_card",
  keyword: "KV Cache",
  aliases: ["键值缓存"],
  explanation: "复用已计算的键和值。",
  originMeeting: "meeting-1",
  status: "active",
  validUntil: null,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
}, {
  id: "decision-old",
  kind: "meeting_decision",
  decision: "旧方案",
  originMeeting: "meeting-0",
  status: "superseded",
  validUntil: null,
  decidedAt: "2026-08-29T10:00:00.000Z",
  createdAt: "2026-08-29T10:00:00.000Z",
  updatedAt: "2026-08-29T10:00:00.000Z",
}]);

async function run(): Promise<void> {
  const aliasResponse = await POST(new NextRequest("http://localhost/api/local-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "键值缓存", kind: "knowledge_card" }),
  }));
  assert.equal(aliasResponse.status, 200);
  const aliasPayload = await aliasResponse.json() as { results: Array<{ id: string; matchedBy: string }> };
  assert.equal(aliasPayload.results[0]?.id, "card-kv");
  assert.equal(aliasPayload.results[0]?.matchedBy, "alias");

  const decisionResponse = await POST(new NextRequest("http://localhost/api/local-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "旧方案", kind: "meeting_decision" }),
  }));
  assert.equal((await decisionResponse.json() as { results: unknown[] }).results.length, 0, "superseded decisions are filtered");

  const invalid = await POST(new NextRequest("http://localhost/api/local-memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "   " }),
  }));
  assert.equal(invalid.status, 400);
  console.log("local-memory route tests passed");
}

void run();
