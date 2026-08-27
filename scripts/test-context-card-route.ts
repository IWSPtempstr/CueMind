import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { POST } from "@/app/api/context-cards/route";
import {
  AgentReachSearchError,
  searchWithAgentReach,
} from "@/lib/agent-reach-search";
import {
  InsufficientSearchSourcesError,
  searchWeb,
} from "@/lib/search";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;

interface RouteTrace {
  candidateId: string;
  datasetVersion: string;
  windowingVersion: string;
  decisionSource: string;
  duplicateOfCandidateId?: string;
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

type AgentReachSearchMock = (query: string, timeoutMs: number) => Promise<unknown>;

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
    candidateId: "candidate-demo-001",
    datasetVersion: "demo-manifest-v1",
    windowingVersion: "candidate-window-v1",
    coreStartMs: 12000,
    coreEndMs: 18000,
    contextStartMs: 10000,
    contextEndMs: 18000,
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
    assert.equal(payload.trace.candidateId, "candidate-demo-001");
    assert.equal(payload.trace.datasetVersion, "demo-manifest-v1");
    assert.equal(payload.trace.windowingVersion, "candidate-window-v1");
    assert.equal(payload.trace.decisionSource, "model");
    assert.equal(payload.trace.finalState, "card_shown");
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
    assert.equal(payload.trace.finalState, "card_shown");
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
    assert.equal(payload.trace.finalState, "invalid_schema");
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

async function testGenericKeywordSkipsModel(): Promise<void> {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "技术" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "model_skip");
    assert.equal(payload.trace.decisionSource, "hard_rule");
  } finally {
    await stopMockServer(server);
  }
}

async function testKnownKeywordDuplicateIsSuppressedWithOriginalCandidate(): Promise<void> {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      knownKeywords: [" kv cache "],
      knownCandidates: [{ candidateId: "candidate-old", keyword: " kv cache " }],
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "suppressed_as_duplicate");
    assert.equal(payload.trace.decisionSource, "hard_rule");
    assert.equal(payload.trace.duplicateOfCandidateId, "candidate-old");
  } finally {
    await stopMockServer(server);
  }
}

async function testRepeatedOverlapWindowIsSuppressedWithOriginalCandidate(): Promise<void> {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
  });
  try {
    const response = await POST(makeRequest(baseBody({
      candidateId: "candidate-overlap-002",
      coreStartMs: 18000,
      coreEndMs: 24000,
      contextStartMs: 16000,
      contextEndMs: 24000,
      knownKeywords: ["kv cache"],
      knownCandidates: [{ candidateId: "candidate-overlap-001", keyword: "KV Cache" }],
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    const payload = await readPayload(response);
    assert.equal(payload.card, null);
    assert.equal(payload.trace.finalState, "suppressed_as_duplicate");
    assert.equal(payload.trace.decisionSource, "hard_rule");
    assert.equal(payload.trace.duplicateOfCandidateId, "candidate-overlap-001");
  } finally {
    await stopMockServer(server);
  }
}

async function testDistinctNormalizedKeywordIsNotSuppressed(): Promise<void> {
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
      knownKeywords: [" RAG "],
      knownCandidates: [{ candidateId: "candidate-rag", keyword: "rag" }],
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    })));
    const payload = await readPayload(response);
    assert.ok(payload.card);
    assert.equal(payload.trace.finalState, "card_shown");
    assert.equal(payload.trace.decisionSource, "model");
    assert.equal(payload.trace.duplicateOfCandidateId, undefined);
    assert.equal(calls, 2);
  } finally {
    await stopMockServer(server);
  }
}

async function testInvalidCandidateIntervalIsRejected(): Promise<void> {
  const response = await POST(makeRequest(baseBody({ coreStartMs: 20000, coreEndMs: 10000 })));
  assert.equal(response.status, 400);
  const payload = await readPayload(response);
  assert.equal(payload.card, null);
  assert.equal(payload.trace.finalState, "invalid_request");
}

async function testMissingCandidateIdIsRejected(): Promise<void> {
  const body = baseBody();
  delete body.candidateId;
  const response = await POST(makeRequest(body));
  assert.equal(response.status, 400);
  const payload = await readPayload(response);
  assert.equal(payload.card, null);
  assert.equal(payload.trace.finalState, "invalid_request");
}

// 实时简单模式：仅携带 hook 发送的四个字段（knownKeywords 校验保持必填，与线上一致），
// 不含 candidateId/时间元数据时应在服务端合成元数据并走通完整流程。
async function testLiveSimpleBodyWithoutMetadataGeneratesCard(): Promise<void> {
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
    const response = await POST(makeRequest({
      recentTranscript: "我们讨论一下 KV Cache 对推理吞吐的影响",
      knownKeywords: [],
      transcriptChunkIds: ["chunk-live-1"],
      settings: settings({ llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" }),
    }));
    assert.equal(response.status, 200);
    const payload = await readPayload(response);
    assert.notEqual(payload.failure?.reason, "Invalid context-card request");
    assert.ok(typeof payload.trace.candidateId === "string" && payload.trace.candidateId.length > 0);
    assert.equal(payload.trace.datasetVersion, "client-live");
    assert.equal(payload.trace.windowingVersion, "hook-1");
    assert.ok(payload.card);
    assert.equal(payload.card.keyword, "KV Cache");
    assert.equal(payload.trace.finalState, "card_shown");
    assert.equal(calls, 2);
  } finally {
    await stopMockServer(server);
  }
}

// mixed 元数据：candidateId 存在但缺少 coreStartMs 时仍应拒绝。
async function testPartialMetadataIsStillRejected(): Promise<void> {
  const body = baseBody();
  delete body.coreStartMs;
  const response = await POST(makeRequest(body));
  assert.equal(response.status, 400);
  const payload = await readPayload(response);
  assert.equal(payload.card, null);
  assert.equal(payload.failure?.reason, "Invalid context-card request");
  assert.equal(payload.trace.finalState, "invalid_request");
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
    assert.equal(payload.trace.finalState, "card_shown");
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

async function testSearchRejectsEmptyTitleAndSnippet(): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    results: [
      { title: "", url: "https://example.com/empty-title", content: "usable snippet" },
      { title: "Usable title", url: "https://example.com/empty-snippet", content: "" },
      { title: "Only usable source", url: "https://example.com/usable", content: "usable snippet" },
    ],
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => searchWeb({
        provider: "tavily",
        apiKey: "test-key",
        query: "metadata validation",
        timeoutMs: 1_000,
        enableAgentReachFallback: false,
      }),
      (error: unknown) => error instanceof InsufficientSearchSourcesError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testSearchRejectsDuplicateUrlsAsOneSource(): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    results: [
      { title: "First result", url: "https://example.com/same", content: "first" },
      { title: "Duplicate result", url: "https://example.com/same#section", content: "duplicate" },
    ],
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      () => searchWeb({
        provider: "tavily",
        apiKey: "test-key",
        query: "duplicate validation",
        timeoutMs: 1_000,
        enableAgentReachFallback: false,
      }),
      (error: unknown) => error instanceof InsufficientSearchSourcesError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testTavilyFetchFailureFallsBackToAgentReach(): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  installAgentReachMock(async () => [
    { title: "Fallback source", url: "https://example.com/fallback", snippet: "fallback context" },
    { title: "Fallback source two", url: "https://example.com/fallback-two", snippet: "more fallback context" },
  ]);
  try {
    const result = await searchWeb({
      provider: "tavily",
      apiKey: "test-key",
      query: "network fallback",
      timeoutMs: 1_000,
    });
    assert.equal(result.provider, "agent-reach");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.results.length, 2);
  } finally {
    restoreAgentReachMock();
    globalThis.fetch = previousFetch;
  }
}

async function testTavilyAuthFailureDoesNotFallBack(): Promise<void> {
  const previousFetch = globalThis.fetch;
  let fallbackCalls = 0;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;
  installAgentReachMock(async () => {
    fallbackCalls += 1;
    return [
      { title: "Unexpected fallback", url: "https://example.com/unexpected", snippet: "must not be used" },
      { title: "Unexpected fallback two", url: "https://example.com/unexpected-two", snippet: "must not be used" },
    ];
  });
  try {
    await assert.rejects(
      () => searchWeb({
        provider: "tavily",
        apiKey: "test-key",
        query: "authentication failure",
        timeoutMs: 1_000,
      }),
      /Tavily returned HTTP 401/,
    );
    assert.equal(fallbackCalls, 0);
  } finally {
    restoreAgentReachMock();
    globalThis.fetch = previousFetch;
  }
}

async function testAgentReachMockPreservesInvalidOutputError(): Promise<void> {
  installAgentReachMock(async () => "not-json");
  try {
    await assert.rejects(
      () => searchWithAgentReach({ query: "invalid output", timeoutMs: 1_000 }),
      (error: unknown) => error instanceof AgentReachSearchError && error.code === "agent_reach_invalid_output",
    );
  } finally {
    restoreAgentReachMock();
  }
}

async function testAgentReachMockPreservesInsufficientSourcesError(): Promise<void> {
  installAgentReachMock(async () => [
    { title: "", url: "https://example.com/empty-title", snippet: "ignored" },
    { title: "Empty snippet", url: "https://example.com/empty-snippet", snippet: "" },
    { title: "Only source", url: "https://example.com/only", snippet: "one source" },
  ]);
  try {
    await assert.rejects(
      () => searchWithAgentReach({ query: "insufficient sources", timeoutMs: 1_000 }),
      (error: unknown) => error instanceof AgentReachSearchError && error.code === "agent_reach_no_usable_sources",
    );
  } finally {
    restoreAgentReachMock();
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
    await testGenericKeywordSkipsModel();
    await testKnownKeywordDuplicateIsSuppressedWithOriginalCandidate();
    await testRepeatedOverlapWindowIsSuppressedWithOriginalCandidate();
    await testDistinctNormalizedKeywordIsNotSuppressed();
    await testInvalidCandidateIntervalIsRejected();
    await testMissingCandidateIdIsRejected();
    await testLiveSimpleBodyWithoutMetadataGeneratesCard();
    await testPartialMetadataIsStillRejected();
    await testTavilyFallsBackToAgentReachWhenKeyMissing();
    await testAgentReachUnavailableReplacesMissingKeyFailure();
    await testAgentReachFallbackCanBeDisabled();
    await testServerTavilyKeyTakesPrecedence();
    await testSearchRejectsEmptyTitleAndSnippet();
    await testSearchRejectsDuplicateUrlsAsOneSource();
    await testTavilyFetchFailureFallsBackToAgentReach();
    await testTavilyAuthFailureDoesNotFallBack();
    await testAgentReachMockPreservesInvalidOutputError();
    await testAgentReachMockPreservesInsufficientSourcesError();
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
