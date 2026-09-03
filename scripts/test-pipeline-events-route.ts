// Pipeline-events route regression (security plan §6.4): session ownership +
// bounded batch/event sizes + bounded cumulative file growth (rotation).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/pipeline-events/route";
import { POST as createSession } from "@/app/api/sessions/route";
import { parsePipelineEvents } from "@/lib/pipeline-event-store";

// 会话授权夹具：session store 指向临时目录，避免污染开发 .data。
process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-pipeline-events-route-"));
const eventsFile = path.join(mkdtempSync(path.join(tmpdir(), "cuemind-pipeline-events-file-")), "events.jsonl");
process.env.CUEMIND_PIPELINE_EVENTS_FILE = eventsFile;

const SESSION_ID = "pipeline-events-suite";
let sessionToken = "";

async function bootstrapSession(): Promise<void> {
  const response = await createSession(new Request("http://localhost/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: SESSION_ID, title: SESSION_ID, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), transcriptChunks: [], suggestionBatches: [], chatMessages: [], meetingReport: null }),
  }) as unknown as NextRequest);
  assert.equal(response.status, 200);
  sessionToken = (await response.json() as { sessionAccessToken: string }).sessionAccessToken;
}

function makeRequest(body: unknown, options: { token?: string; noAuth?: boolean; sessionId?: string; rawBody?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("x-session-id", options.sessionId ?? SESSION_ID);
  if (!options.noAuth) headers.set("X-Session-Token", options.token ?? sessionToken);
  return new Request("http://localhost/api/pipeline-events", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
}

const validEvent = { runId: "run-1", name: "keyword_start", atMs: 1, metadata: { status: "started" } };

async function main(): Promise<void> {
  await bootstrapSession();

  // 缺 sessionId header → 400
  assert.equal((await POST(makeRequest([validEvent], { sessionId: "" }))).status, 400, "缺 sessionId 应 400");
  // 缺 token → 401
  assert.equal((await POST(makeRequest([validEvent], { noAuth: true }))).status, 401, "缺 token 应 401");
  // 错 token → 401
  assert.equal((await POST(makeRequest([validEvent], { token: "definitely-wrong-token" }))).status, 401, "错 token 应 401");

  // 非法 batch：>32 条 → 400
  const flood = Array.from({ length: 33 }, (_, index) => ({ ...validEvent, name: index === 0 ? "keyword_start" : "keyword_end", atMs: index + 1 }));
  assert.equal((await POST(makeRequest(flood))).status, 400, ">32 条事件应 400");
  // 非法 batch：单条 metadata 超大（>2KB 序列化）→ 400
  const bloated = [{ ...validEvent, metadata: { blob: "x".repeat(3000) } }];
  assert.equal((await POST(makeRequest(bloated))).status, 400, "metadata 超大应 400");
  assert.equal(parsePipelineEvents(bloated), null, "store 层 metadata 上限应拒绝");
  // 非法 batch：runId 超长 → 400
  assert.equal(
    (await POST(makeRequest([{ ...validEvent, runId: "r".repeat(200) }]))).status,
    400,
    "runId 超长应 400",
  );

  // 合法 batch → accepted: 1，写入配置的临时文件
  const ok = await POST(makeRequest([validEvent]));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { accepted: 1 });
  assert.ok(existsSync(eventsFile), "事件应写入 CUEMIND_PIPELINE_EVENTS_FILE");
  assert.equal(readFileSync(eventsFile, "utf8").trim().split("\n").length, 1);

  // 累计上限：超过 16MiB 的文件在下次写入前轮转为 .1
  writeFileSync(eventsFile, "x".repeat(16 * 1024 * 1024 + 1));
  assert.ok(statSync(eventsFile).size > 16 * 1024 * 1024);
  const rotated = await POST(makeRequest([{ runId: "run-2", name: "keyword_start", atMs: 1 }]));
  assert.equal(rotated.status, 200, "轮转后写入应成功");
  assert.ok(existsSync(`${eventsFile}.1`), "超限旧文件应轮转为 .1");
  assert.ok(statSync(eventsFile).size < 16 * 1024 * 1024, "新文件从小体量重新开始");

  console.log("pipeline events route regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
