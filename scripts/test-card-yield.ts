// 卡片链路并发让位验证：模拟 suggestions/summarize 周期性任务与 context-cards
// 并发打同一本地 llama-server，断言：卡片请求不因并发争抢而超时（finalState=card_shown），
// 且周期性任务在卡片 in-flight 时让位（返回 yielded 信号，跳过本轮，不占用 llama）。
//
// 这是一个机制级回归：修复前 cardInflight 只覆盖卡片生成阶段、且只有 ask 让位，
// suggestions/summarize 不知道卡片在跑 → 并发排队 → 卡片 5s/8s 预算内超时。
// 修复方向：方向2（关键词阶段也纳入 cardInflight）+ 方向1（suggestions/summarize 让位）。

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
import { POST as POST_CARD } from "@/app/api/context-cards/route";
import { POST as POST_SUGGESTIONS } from "@/app/api/suggestions/route";
import { POST as POST_SUMMARIZE } from "@/app/api/summarize/route";
import { POST as createSession } from "@/app/api/sessions/route";
import { withCardInflight } from "@/lib/llama-cpp";

// 账本旁路写入指向临时目录，避免污染开发 .data（store 懒初始化）。
if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-card-yield-test-"));
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

// --- mock provider：卡片与非卡片请求共用，人工时延 > 卡片预算，复现并发超时 ---

// 卡片关键词/生成预算 5s/8s；mock 时延设为 1200ms。单请求 1200ms 在卡片预算内，
// 但若卡片与 suggestions 并发争抢同一 mock 服务器（串行处理），卡片会排队超过预算。
// 修复语义：卡片 in-flight 时 suggestions/summarize 让位，卡片独占 → 不超时。
const PROVIDER_DELAY_MS = 300;

function startMockProvider(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    // 串行队列：一次只处理一个请求，模拟单槽 llama-server（-np 1）排队行为。
    let queue = Promise.resolve();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Connection", "close");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        queue = queue.then(
          () =>
            new Promise<void>((resolveStep) => {
              setTimeout(() => {
                try {
                  const parsed = JSON.parse(raw) as { messages?: Array<{ content: string }> };
                  const joined = (parsed.messages ?? []).map((m) => m.content).join("\n");
                  res.writeHead(200, { "Content-Type": "application/json" });
                  let bodyJson: string;
                  if (joined.includes("<search_evidence_untrusted>")) {
                    bodyJson = JSON.stringify({ choices: [{ message: { content: JSON.stringify({
                      keyword: "KV Cache",
                      keyPoints: ["缓存键值对，加速大模型推理。", "KV Cache 命中率直接影响吞吐。", "会议正讨论推理优化。"],
                      whyNow: "会议正在讨论吞吐优化。",
                    }) } }] });
                  } else if (joined.includes("具体技术关键词")) {
                    bodyJson = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keyword: "KV Cache" }) } }] });
                  } else if (joined.includes("<recent_transcript>")) {
                    bodyJson = JSON.stringify({ choices: [{ message: { content: JSON.stringify({
                      suggestions: [
                        { type: "question", preview: "KV cache 会不会影响" },
                        { type: "talking_point", detail: "讨论推理吞吐", preview: "KV cache 吞吐" },
                        { type: "fact_check", detail: "缓存命中", preview: "命中率" },
                      ],
                    }) } }] });
                  } else {
                    bodyJson = JSON.stringify({ choices: [{ message: { content: "一段会议摘要。" } }] });
                  }
                  res.end(bodyJson);
                } catch {
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ choices: [{ message: { content: "{\"keyword\":\"KV Cache\"}" } }] }));
                } finally {
                  resolveStep();
                }
              }, PROVIDER_DELAY_MS);
            }),
        );
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

const sessionTokens = new Map<string, string>();

function cardBody(baseUrl: string, index: number): Record<string, unknown> {
  return {
    sessionId: "yield-card",
    runId: `run-${index}`,
    candidateId: `cand-${index}`,
    datasetVersion: "client-live",
    windowingVersion: "hook-1",
    coreStartMs: 0,
    coreEndMs: 3000,
    contextStartMs: 0,
    contextEndMs: 5000,
    recentTranscript: `并发让位验证 ${index}：讨论 KV Cache 吞吐`,
    shownKeywords: [],
    currentTopics: ["KV Cache"],
    unresolvedTopics: [],
    knownKeywords: [],
    knownCandidates: [],
    transcriptChunkIds: [`chunk-${index}`],
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

function suggestionsBody(baseUrl: string): Record<string, unknown> {
  return {
    sessionId: "yield-suggestions",
    recentTranscript: "会议正在讨论 KV Cache 推理吞吐优化。",
    earlierSummary: "之前讨论了模型推理优化。",
    previousSuggestions: "",
    suggestionsPrompt: "",
    settings: {
      llamaCppBaseUrl: baseUrl,
      llamaCppModel: "qwen3",
    },
  };
}

function summarizeBody(baseUrl: string): Record<string, unknown> {
  return {
    sessionId: "yield-suggestions",
    earlierTranscript: "会议正在讨论 KV Cache 推理吞吐优化。",
    summarizationPrompt: "",
    settings: {
      llamaCppBaseUrl: baseUrl,
      llamaCppModel: "qwen3",
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
  for (const id of ["yield-card", "yield-suggestions"]) {
    const response = await createSession(new Request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), transcriptChunks: [], suggestionBatches: [], chatMessages: [], meetingReport: null }),
    }) as unknown as NextRequest);
    assert.equal(response.status, 200);
    sessionTokens.set(id, (await response.json() as { sessionAccessToken: string }).sessionAccessToken);
  }
}

async function runCard(baseUrl: string, index: number): Promise<void> {
  const startedAt = performance.now();
  const response = await POST_CARD(makeRequest("/api/context-cards", cardBody(baseUrl, index)));
  const payload = (await response.json()) as {
    card?: unknown;
    failure?: { reason: string };
    trace: { finalState: string; totalLatencyMs: number; events?: Array<{ type: string; durationMs?: number }> };
  };
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`card ${index}: finalState=${payload.trace.finalState} elapsed=${elapsed}ms totalLatencyMs=${payload.trace.totalLatencyMs}ms failure=${payload.failure?.reason ?? "none"}`);
  if (payload.trace.events) {
    for (const event of payload.trace.events) {
      console.log(`    event type=${event.type} durationMs=${event.durationMs ?? "-"}`);
    }
  }
  assert.equal(payload.trace.finalState, "card_shown", `卡片 ${index} 应出卡（当前 ${payload.trace.finalState} failure=${payload.failure?.reason ?? ""}）`);
  assert.ok(payload.card !== null, `卡片 ${index} 应返回卡片`);
}

// --- main ---

const CARD_SAMPLES = 6;

async function main(): Promise<void> {
  await bootstrapSessions();
  installSearchMock();
  const { server, baseUrl } = await startMockProvider();
  try {
    // 基线：单独跑卡片（无并发），确认 mock 下卡片能出卡（不超时）。
    for (let index = 0; index < 2; index += 1) {
      await runCard(baseUrl, index);
    }

    // 机制验证 1（方向1）：卡片链路 in-flight 时，周期性任务（suggestions/summarize）
    // 必须让位（返回 yielded:true），不占用 llama。用 withCardInflight 确定性占住计数，
    // 避免时序竞赛。
    const holdCard = withCardInflight(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    );
    const sugResponse = await POST_SUGGESTIONS(makeRequest("/api/suggestions", suggestionsBody(baseUrl)));
    const sumResponse = await POST_SUMMARIZE(makeRequest("/api/summarize", summarizeBody(baseUrl)));
    await holdCard;
    const sugPayload = (await sugResponse.json()) as { yielded?: boolean; error?: string };
    const sumPayload = (await sumResponse.json()) as { yielded?: boolean; error?: string };
    console.log(`suggestions in-flight: status=${sugResponse.status} yielded=${sugPayload.yielded ?? false}`);
    console.log(`summarize in-flight: status=${sumResponse.status} yielded=${sumPayload.yielded ?? false}`);
    assert.equal(sugPayload.yielded, true, "卡片 in-flight 时 suggestions 应让位（yielded:true）");
    assert.equal(sumPayload.yielded, true, "卡片 in-flight 时 summarize 应让位（yielded:true）");

    // 机制验证 2（并发集成）：卡片与周期性任务并发时，卡片不超时；
    // 卡片不再与周期任务争抢单槽 llama → finalState=card_shown。
    const periodicTasks = [
      POST_SUGGESTIONS(makeRequest("/api/suggestions", suggestionsBody(baseUrl))),
      POST_SUMMARIZE(makeRequest("/api/summarize", summarizeBody(baseUrl))),
    ];
    for (let index = 2; index < 2 + CARD_SAMPLES; index += 1) {
      await runCard(baseUrl, index);
    }
    await Promise.all(periodicTasks);

    console.log("card yield concurrency check passed (card no timeout under periodic-load)");
  } finally {
    restoreFetch();
    await stopMockServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
