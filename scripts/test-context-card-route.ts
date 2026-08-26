import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { POST } from "@/app/api/context-cards/route";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;

interface RouteTrace {
  modelProvider: string;
  modelName: string;
  modelBaseUrl: string;
  finalState: string;
  events?: Array<{
    type: string;
    tool?: string;
    provider?: string;
    fallbackUsed?: boolean;
    resultCount?: number;
  }>;
}

interface RoutePayload {
  card: { keyword: string; explanation: string; whyNow: string } | null;
  failure?: { reason: string };
  trace: RouteTrace;
}

// --- mock model server (OpenAI-compatible /v1/chat/completions) ---

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function chatCompletion(content: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

function startMockServer(
  handler: MockHandler,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Connection", "close");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => handler(req, res, raw));
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

// --- search interception (offline, deterministic) ---

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
    return realFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

type AgentReachSearchMock = (query: string, timeoutMs: number) => Promise<Array<{
  title: string;
  url: string;
  snippet: string;
}>>;

declare global {
  var __cuemindAgentReachSearchMock: AgentReachSearchMock | undefined;
}

function installAgentReachMock(mock: AgentReachSearchMock): void {
  globalThis.__cuemindAgentReachSearchMock = mock;
}

function restoreAgentReachMock(): void {
  delete globalThis.__cuemindAgentReachSearchMock;
}

// --- request builders ---

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/context-cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelProvider: "llama.cpp",
    llamaCppBaseUrl: "",
    llamaCppModel: "",
    llamaCppApiKey: "",
    remoteApiBaseUrl: "",
    remoteApiModel: "",
    remoteApiApiKey: "",
    searchProvider: "tavily",
    searchApiKey: "test-search-key",
    ...overrides,
  };
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recentTranscript: "我们讨论一下 KV Cache 对推理吞吐的影响",
    knownKeywords: [],
    transcriptChunkIds: ["chunk-1"],
    settings: settings(),
    ...overrides,
  };
}

async function readPayload(response: Response): Promise<RoutePayload> {
  return (await response.json()) as RoutePayload;
}

// --- test cases ---

async function testInvalidRequest(): Promise<void> {
  const response = await POST(makeRequest({ recentTranscript: "missing settings" }));
  assert.equal(response.status, 400);
  const payload = await readPayload(response);
  assert.equal(payload.card, null);
  assert.equal(payload.failure?.reason, "Invalid context-card request");
  assert.equal(payload.trace.finalState, "invalid_request");
}

async function testLocalProviderSelected(): Promise<void> {
  let calls = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
    } else {
      writeJson(res, 200, chatCompletion({
        keyword: "KV Cache",
        explanation: "缓存键值对以加速大模型推理。",
        whyNow: "会议正在讨论吞吐优化。",
      }));
    }
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ modelProvider: "llama.cpp", llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    assert.equal(response.status, 200);
    const payload = await readPayload(response);
    assert.ok(payload.card);
    assert.equal(payload.trace.modelProvider, "llama.cpp");
    assert.equal(payload.trace.modelName, "qwen3");
    assert.equal(payload.trace.modelBaseUrl, baseUrl);
    assert.equal(payload.trace.finalState, "card_generated");
    assert.equal(payload.card.keyword, "KV Cache");
    assert.equal(calls, 2);
  } finally {
    await stopMockServer(server);
  }
}

async function testRemoteProviderSelected(): Promise<void> {
  let calls = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
    } else {
      writeJson(res, 200, chatCompletion({
        keyword: "KV Cache",
        explanation: "缓存键值对以加速大模型推理。",
        whyNow: "会议正在讨论吞吐优化。",
      }));
    }
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({
        modelProvider: "remote-api",
        remoteApiBaseUrl: baseUrl,
        remoteApiModel: "remote-model",
      }),
    })));
    assert.equal(response.status, 200);
    const payload = await readPayload(response);
    assert.ok(payload.card);
    assert.equal(payload.trace.modelProvider, "remote-api");
    assert.equal(payload.trace.modelName, "remote-model");
    assert.equal(payload.trace.modelBaseUrl, baseUrl);
    assert.equal(payload.trace.finalState, "card_generated");
  } finally {
    await stopMockServer(server);
  }
}

async function testProviderFailureWithoutSilentFallback(): Promise<void> {
  let remoteCalls = 0;
  const failing = await startMockServer((_req, res) => {
    writeJson(res, 500, { error: { message: "boom" } });
  });
  const remote = await startMockServer((_req, res) => {
    remoteCalls += 1;
    writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({
        modelProvider: "llama.cpp",
        llamaCppBaseUrl: failing.baseUrl,
        llamaCppModel: "qwen3",
        remoteApiBaseUrl: remote.baseUrl,
        remoteApiModel: "remote-model",
      }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "model_failed");
    assert.equal(payload.trace.modelProvider, "llama.cpp");
    assert.match(payload.failure?.reason ?? "", /llama\.cpp/);
    assert.equal(remoteCalls, 0);
  } finally {
    await stopMockServer(failing.server);
    await stopMockServer(remote.server);
  }
}

async function testInvalidCardSchema(): Promise<void> {
  let calls = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
    } else {
      writeJson(res, 200, chatCompletion({ keyword: "KV Cache", explanation: "缺少 whyNow 字段" }));
    }
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "model_failed");
    assert.equal(payload.failure?.reason, "llama.cpp provider returned an invalid schema");
  } finally {
    await stopMockServer(server);
  }
}

async function testSearchFailureAfterKeyword(): Promise<void> {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3", searchProvider: "bing", searchApiKey: "" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "search_failed");
    assert.equal(payload.failure?.reason, "Search API key is not configured");
  } finally {
    await stopMockServer(server);
  }
}

async function testTavilyFallsBackToAgentReachWhenKeyMissing(): Promise<void> {
  let calls = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    calls += 1;
    if (calls === 1) {
      writeJson(res, 200, chatCompletion({ keyword: "Agent Harness" }));
    } else {
      writeJson(res, 200, chatCompletion({
        keyword: "Agent Harness",
        explanation: "用于组织模型、工具与执行循环的代理运行框架。",
        whyNow: "会议正在讨论 Agent Harness 的设计与实现。",
      }));
    }
  });
  installAgentReachMock(async () => ([
    { title: "Agent Harness intro", url: "https://example.com/harness", snippet: "Harness organizes tools and execution loops." },
    { title: "Second harness source", url: "https://example.com/harness-2", snippet: "Additional agent harness context." },
  ]));
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3", searchApiKey: "" }),
    })));
    const payload = await readPayload(response);
    assert.ok(payload.card);
    assert.equal(payload.trace.finalState, "card_generated");
    assert.ok(payload.trace.events?.some((event) =>
      event.type === "tool_result" &&
      event.tool === "search_web" &&
      event.provider === "agent-reach" &&
      event.fallbackUsed === true &&
      event.resultCount === 2,
    ));
  } finally {
    restoreAgentReachMock();
    await stopMockServer(server);
  }
}

async function testAgentReachUnavailableReplacesMissingKeyFailure(): Promise<void> {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "Agent Harness" }));
  });
  installAgentReachMock(async () => {
    throw new Error("agent reach unavailable in test");
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3", searchApiKey: "" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "search_failed");
    assert.equal(payload.failure?.reason, "agent-reach search unavailable");
  } finally {
    restoreAgentReachMock();
    await stopMockServer(server);
  }
}

async function testAgentReachFallbackCanBeDisabled(): Promise<void> {
  installAgentReachMock(async () => ([
    { title: "fallback source", url: "https://example.com/fallback", snippet: "fallback" },
    { title: "fallback source 2", url: "https://example.com/fallback-2", snippet: "fallback" },
  ]));
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "Agent Harness" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({
        llamaCppBaseUrl: baseUrl,
        llamaCppModel: "qwen3",
        searchApiKey: "",
        enableAgentReachFallback: false,
      }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "search_failed");
    assert.equal(payload.failure?.reason, "Search API key is not configured");
  } finally {
    restoreAgentReachMock();
    await stopMockServer(server);
  }
}

async function testServerTavilyKeyTakesPrecedence(): Promise<void> {
  const previous = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "server-tavily-key";
  let receivedBody = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = fetchUrl(input);
    if (url.includes("api.tavily.com")) {
      receivedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(JSON.stringify({
        results: [
          { title: "Server source", url: "https://example.com/server", content: "server" },
          { title: "Server source 2", url: "https://example.com/server-2", content: "server" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "Agent Harness", explanation: "解释", whyNow: "现在相关" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3", searchApiKey: "browser-key" }),
    })));
    const payload = await readPayload(response);
    assert.ok(payload.card);
    assert.equal(JSON.parse(receivedBody).api_key, "server-tavily-key");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
    await stopMockServer(server);
  }
}

async function main(): Promise<void> {
  installSearchMock();
  try {
    await testInvalidRequest();
    await testLocalProviderSelected();
    await testRemoteProviderSelected();
    await testProviderFailureWithoutSilentFallback();
    await testInvalidCardSchema();
    await testSearchFailureAfterKeyword();
    await testTavilyFallsBackToAgentReachWhenKeyMissing();
    await testAgentReachUnavailableReplacesMissingKeyFailure();
    await testAgentReachFallbackCanBeDisabled();
    await testServerTavilyKeyTakesPrecedence();
  } finally {
    restoreFetch();
    restoreAgentReachMock();
  }
  console.log("context card route regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
