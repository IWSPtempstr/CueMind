import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/sessions/route";
import { POST as realtimePost } from "@/app/api/realtime-transcribe/route";
import { POST as summarizePost } from "@/app/api/summarize/route";
import { POST as suggestionsPost } from "@/app/api/suggestions/route";
import { POST as postmeetingPost } from "@/app/api/postmeeting-transcript/route";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-session-route-"));
process.env.CUEMIND_SESSION_STORE = "jsonl";

function request(url: string, init?: { method?: string; headers?: HeadersInit; body?: BodyInit | null }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

const snapshot = (id: string) => ({
  id,
  title: "测试会话",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  transcriptChunks: [],
  suggestionBatches: [],
  chatMessages: [],
  meetingReport: null,
});

async function main(): Promise<void> {
  const create = await POST(request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot("session-a")),
  }));
  assert.equal(create.status, 200);
  const created = await create.json() as { sessionAccessToken: string };
  assert.ok(created.sessionAccessToken);

  const noToken = await GET(request("/api/sessions?id=session-a"));
  assert.equal(noToken.status, 401);
  const wrongToken = await GET(request("/api/sessions?id=session-a", { headers: { "X-Session-Token": "wrong" } }));
  assert.equal(wrongToken.status, 401);

  const headers = { "X-Session-Token": created.sessionAccessToken };
  const correct = await GET(request("/api/sessions?id=session-a", { headers }));
  assert.equal(correct.status, 200);
  assert.equal((await correct.json() as { session: { id: string } }).session.id, "session-a");

  const update = await POST(request("/api/sessions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(snapshot("session-a")),
  }));
  assert.equal(update.status, 200);
  assert.equal((await update.json() as { sessionAccessToken?: string }).sessionAccessToken, undefined);

  const other = await POST(request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot("session-b")),
  }));
  assert.equal(other.status, 200);
  const otherToken = await other.json() as { sessionAccessToken: string };
  const crossSession = await GET(request("/api/sessions?id=session-a", { headers: { "X-Session-Token": otherToken.sessionAccessToken } }));
  assert.equal(crossSession.status, 401);

  const realtimeBody = JSON.stringify({ sessionId: "session-a", runId: "run-a", snapshots: [] });
  const realtimeNoToken = await realtimePost(request("/api/realtime-transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: realtimeBody,
  }));
  assert.equal(realtimeNoToken.status, 401);
  const realtime = await realtimePost(request("/api/realtime-transcribe", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: realtimeBody,
  }));
  assert.equal(realtime.status, 200);

  const summarizeBody = JSON.stringify({ sessionId: "session-a", earlierTranscript: "会议内容" });
  const summarizeNoToken = await summarizePost(request("/api/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: summarizeBody,
  }));
  assert.equal(summarizeNoToken.status, 401);
  const suggestionsNoToken = await suggestionsPost(request("/api/suggestions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-a", recentTranscript: "会议内容" }),
  }));
  assert.equal(suggestionsNoToken.status, 401);

  const tooManyChunks = await postmeetingPost(request("/api/postmeeting-transcript", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-a", transcriptChunks: Array.from({ length: 2_001 }, () => ({ text: "x" })) }),
  }));
  assert.equal(tooManyChunks.status, 413);
  const tooMuchText = await postmeetingPost(request("/api/postmeeting-transcript", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session-a", transcriptChunks: [{ text: "x".repeat(20_000) }, { text: "y".repeat(20_000) }] }),
  }));
  assert.equal(tooMuchText.status, 413);

  console.log("session route regression passed");
}

void main();
