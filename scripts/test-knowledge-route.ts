import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { GET, POST, PATCH, DELETE } from "@/app/api/knowledge/route";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-knowledge-route-"));
process.env.CUEMIND_SESSION_STORE = "jsonl";
process.env.CUEMIND_KNOWLEDGE_STORE = "jsonl";

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

async function main(): Promise<void> {
  const session = await sessionsPost(request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "knowledge-a", title: "知识测试", transcriptChunks: [] }) }));
  assert.equal(session.status, 200);
  const { sessionAccessToken } = await session.json() as { sessionAccessToken: string };
  const headers = { "content-type": "application/json", "X-Session-Id": "knowledge-a", "X-Session-Token": sessionAccessToken };

  assert.equal((await GET(request("/api/knowledge?sessionId=knowledge-a"))).status, 401);
  assert.equal((await POST(request("/api/knowledge", { method: "POST", headers, body: JSON.stringify({ sessionId: "knowledge-a", title: "KV Cache", content: "缓存机制", summary: "摘要" }) }))).status, 201);
  const listed = await GET(request("/api/knowledge?q=KV&sessionId=knowledge-a", { headers }));
  assert.equal(listed.status, 200);
  const entry = (await listed.json() as { entries: Array<{ id: string; version: number }> }).entries[0];
  assert.ok(entry?.id);
  assert.equal(entry.version, 1);

  const detail = await GET(request(`/api/knowledge/${entry.id}?sessionId=knowledge-a`, { headers }));
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { entry: { title: string } }).entry.title, "KV Cache");

  const patch = await PATCH(request(`/api/knowledge/${entry.id}`, { method: "PATCH", headers, body: JSON.stringify({ sessionId: "knowledge-a", version: 1, summary: "更新摘要" }) }));
  assert.equal(patch.status, 200);
  assert.equal((await patch.json() as { entry: { version: number } }).entry.version, 2);
  assert.equal((await PATCH(request(`/api/knowledge/${entry.id}`, { method: "PATCH", headers, body: JSON.stringify({ sessionId: "knowledge-a", version: 1 }) }))).status, 409);

  assert.equal((await DELETE(request(`/api/knowledge/${entry.id}?sessionId=knowledge-a`, { method: "DELETE", headers }))).status, 200);
  assert.equal((await GET(request(`/api/knowledge/${entry.id}?sessionId=knowledge-a`, { headers }))).status, 404);
  console.log("knowledge route regression passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
