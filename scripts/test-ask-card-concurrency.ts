// 并发让位验证（live-ask 计划批次三，红线 3）：模拟询问并发下重跑卡片路由用例，
// 断言卡片耗时分布不回退（P95 差值 < 30%）。模式沿用 test-context-card-route.ts：
// 本地 mock provider（带固定人工时延）+ globalThis.fetch 搜索层拦截；卡片/询问
// 路由在本进程内直接调用。

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { NextRequest } from "next/server";
import { POST as POST_ASK } from "@/app/api/ask/route";
import { POST as POST_CARD } from "@/app/api/context-cards/route";
import { POST as createSession } from "@/app/api/sessions/route";

// 账本旁路写入指向临时目录，避免污染开发 .data（store 懒初始化）。
if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-concurrency-test-"));
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;

function fetchUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installSearchMock(): void {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = fetchUrl(input);
    if (url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({
        results: [
          { title: "KV Cache explained", url: "https://example.com/kv-cache", content: "KV cache speeds up LLM inference." },
          { title: "Second source", url: "https://example.com/second", content: "More context on KV cache." },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("export.arxiv.org")) {
      return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
    }
    if (url.includes("hn.algolia.com")) {
      return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("api.github.com") || url.includes("api.stackexchange.com")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// --- mock provider：卡片（非流式）与询问（非流式关键词 + 流式生成）共用 ---

// 固定人工时延，让耗时分布可测且两相位条件一致。
const PROVIDER_DELAY_MS = 60;

function startMockProvider(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Connection", "close");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let stream = false;
        try {
          stream = (JSON.parse(raw) as { stream?: unknown }).stream === true;
        } catch {
          // 非法 JSON 按非流式处理。
        }
        setTimeout(() => {
          if (stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            const content = JSON.stringify({
              answer: "并发场景下的引用式回答 [1][2]。",
              sources: [
                { title: "KV Cache explained", url: "https://example.com/kv-cache" },
                { title: "Second source", url: "https://example.com/second" },
              ],
              confidence: "medium",
            });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          // 多态响应：同一份 JSON 同时满足卡片关键词/卡片生成/询问关键词提取。
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  keyword: "KV Cache",
                  keywords: ["KV Cache"],
                  keyPoints: ["缓存键值对，加速大模型推理。", "KV Cache 命中率直接影响吞吐。", "会议正讨论推理优化。"],
                  whyNow: "会议正在讨论吞吐优化。",
                }),
              },
            }],
          }));
        }, PROVIDER_DELAY_MS);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function stopMockServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

// --- 请求构造 ---

function cardBody(baseUrl: string, phase: string, index: number): Record<string, unknown> {
  return {
    sessionId: `concurrency-${phase}`,
    recentTranscript: `并发让位验证 ${phase}-${index}：讨论 KV Cache 吞吐`,
    knownKeywords: [],
    transcriptChunkIds: [`chunk-${phase}-${index}`],
    settings: {
      modelProvider: "llama.cpp",
      llamaCppBaseUrl: baseUrl,
      llamaCppModel: "qwen3",
      llamaCppApiKey: "",
      remoteApiBaseUrl: "",
      remoteApiModel: "",
      remoteApiApiKey: "",
      searchProvider: "tavily",
      searchApiKey: "test-key",
    },
  };
}

const sessionTokens = new Map<string, string>();

function askBody(baseUrl: string, index: number): Record<string, unknown> {
  return {
    sessionId: "concurrency-conc",
    question: `并发询问 ${index}：KV cache 相关问题？`,
    recentTranscript: "会议正在讨论推理优化。",
    settings: {
      modelProvider: "llama.cpp",
      llamaCppBaseUrl: baseUrl,
      llamaCppModel: "qwen3",
      searchApiKey: "test-key",
    },
  };
}

function makeRequest(pathname: string, body: unknown): NextRequest {
  const sessionId = typeof body === "object" && body !== null && typeof (body as { sessionId?: unknown }).sessionId === "string"
    ? (body as { sessionId: string }).sessionId
    : undefined;
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = sessionId ? sessionTokens.get(sessionId) : undefined;
  if (token) headers.set("X-Session-Token", token);
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function bootstrapSessions(): Promise<void> {
  for (const id of ["concurrency-base", "concurrency-conc"]) {
    const response = await createSession(new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), transcriptChunks: [], suggestionBatches: [], chatMessages: [], meetingReport: null }),
    }));
    assert.equal(response.status, 200);
    sessionTokens.set(id, (await response.json() as { sessionAccessToken: string }).sessionAccessToken);
  }
}

async function runCardRequest(baseUrl: string, phase: string, index: number): Promise<number> {
  const startedAt = performance.now();
  const response = await POST_CARD(makeRequest("/api/context-cards", cardBody(baseUrl, phase, index)));
  const payload = (await response.json()) as { card: unknown; trace: { finalState: string } };
  const elapsed = performance.now() - startedAt;
  assert.equal(payload.trace.finalState, "card_shown", `${phase}-${index} 卡片应出卡`);
  assert.ok(payload.card !== null);
  return elapsed;
}

async function runAskRequest(baseUrl: string, index: number): Promise<string> {
  const response = await POST_ASK(makeRequest("/api/ask", askBody(baseUrl, index)));
  const text = await response.text();
  const doneLines = text.split("\n").filter((line) => line.trim().startsWith("data:") && line.includes("\"event\":\"done\""));
  assert.equal(doneLines.length, 1, `ask-${index} 应有一个 done 事件`);
  const done = JSON.parse(doneLines[0].trim().slice(5).trim()) as { finalState: string };
  return done.finalState;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index];
}

// --- main ---

const CARD_SAMPLES = 10;
const ASK_CONCURRENCY = 6;
const P95_REGRESSION_TOLERANCE = 1.3; // P95 差值 < 30%

async function main(): Promise<void> {
  await bootstrapSessions();
  installSearchMock();
  const { server, baseUrl } = await startMockProvider();
  try {
    // 相位 1：无并发基线（顺序跑卡片路由）。
    const baseline: number[] = [];
    for (let index = 0; index < CARD_SAMPLES; index += 1) {
      baseline.push(await runCardRequest(baseUrl, "base", index));
    }

    // 相位 2：先起若干 ask（mock 时延下在途），同时跑同样的卡片用例。
    const askTasks = Array.from({ length: ASK_CONCURRENCY }, (_, index) => runAskRequest(baseUrl, index));
    const concurrent: number[] = [];
    for (let index = 0; index < CARD_SAMPLES; index += 1) {
      concurrent.push(await runCardRequest(baseUrl, "conc", index));
    }
    const askFinalStates = await Promise.all(askTasks);
    for (const finalState of askFinalStates) {
      assert.equal(finalState, "answered", "并发下 ask 流程本身必须跑通（让位后完成）");
    }

    const baselineP95 = p95(baseline);
    const concurrentP95 = p95(concurrent);
    const ratio = concurrentP95 / baselineP95;
    console.log(`card latency baseline    n=${baseline.length} P95=${baselineP95.toFixed(1)}ms samples=[${baseline.map((value) => value.toFixed(0)).join(", ")}]`);
    console.log(`card latency under ${ASK_CONCURRENCY} asks n=${concurrent.length} P95=${concurrentP95.toFixed(1)}ms samples=[${concurrent.map((value) => value.toFixed(0)).join(", ")}]`);
    console.log(`P95 ratio concurrent/baseline = ${ratio.toFixed(3)} (tolerance < ${P95_REGRESSION_TOLERANCE})`);
    assert.ok(
      concurrentP95 <= baselineP95 * P95_REGRESSION_TOLERANCE,
      `卡片 P95 在询问并发下回退：${concurrentP95.toFixed(1)}ms > ${baselineP95.toFixed(1)}ms × ${P95_REGRESSION_TOLERANCE}`,
    );
    console.log("ask concurrency yield check passed (card P95 no regression)");
  } finally {
    restoreFetch();
    await stopMockServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
