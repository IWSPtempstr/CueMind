// Live-ask route regression (plan batch 3, commit 6).
// Mock injection pattern mirrors scripts/test-context-card-route.ts:
// a local OpenAI-compatible mock provider + a globalThis.fetch patch for the
// search layer. Covers: sources>=2 answered, degraded (<2 sources, no
// generation), invalid_schema fail-closed, term-cache hit, privacy red line
// (transcript never leaves via the search layer), askPrompt legacy migration.

import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/ask/route";
import { askCacheClear } from "@/lib/ask-cache";
import { loadCueMindSettings } from "@/hooks/useSettings";
import { ASK_PROMPT, LEGACY_DEFAULT_CHAT_PROMPT } from "@/lib/prompts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;

// --- outbound call recording (privacy red line evidence) ---

interface OutboundCall {
  url: string;
  body: string;
}

/** 搜索层（外发）调用记录：tavily + 四个垂直源的 url 与请求体。 */
const searchLayerCalls: OutboundCall[] = [];
/** 本地 provider（llama.cpp）请求体记录：本地推理，不属于外发链路。 */
const providerBodies: string[] = [];

const SEARCH_HOST_MARKERS = [
  "api.tavily.com",
  "export.arxiv.org",
  "hn.algolia.com",
  "api.github.com",
  "api.stackexchange.com",
];

function fetchUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchBody(init?: FetchInit): string {
  return typeof init?.body === "string" ? init.body : "";
}

// 可配置的 tavily 结果数（来源不足用例降到 1）。
let tavilyResultCount = 2;

function installSearchMock(): void {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = fetchUrl(input);
    const body = fetchBody(init);
    if (SEARCH_HOST_MARKERS.some((marker) => url.includes(marker))) {
      searchLayerCalls.push({ url, body });
    }
    if (url.includes("api.tavily.com")) {
      const results = [
        { title: "KV Cache explained", url: "https://example.com/kv-cache", content: "KV cache speeds up LLM inference." },
        { title: "Second source", url: "https://example.com/second", content: "More context on KV cache." },
      ].slice(0, tavilyResultCount);
      return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // 垂直源保持空结果，走 tavily 回退链，断言确定性更好。
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

// --- mock provider (OpenAI-compatible /v1/chat/completions) ---

interface ProviderScript {
  /** 关键词提取响应（非流式调用）。 */
  keywords: string[];
  /** 生成响应原文（流式调用拼回的内容；合法/非法 schema 都从这里来）。 */
  generationContent: string;
}

function startMockProvider(script: ProviderScript): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Connection", "close");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        providerBodies.push(raw);
        let stream = false;
        try {
          stream = (JSON.parse(raw) as { stream?: unknown }).stream === true;
        } catch {
          // 非法 JSON 按非流式处理。
        }
        if (stream) {
          // SSE：逐段回放 generationContent，data: [DONE] 收尾。
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const piece = JSON.stringify({ choices: [{ delta: { content: script.generationContent } }] });
          res.write(`data: ${piece}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keywords: script.keywords }) } }] }));
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

// --- request / SSE helpers ---

function makeRequest(body: unknown): NextRequest {
  // 路由只消费 headers/json/signal，Request 运行时形状足够；类型上收敛到 NextRequest。
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function askBody(baseUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: "KV cache 为什么能加速自回归解码？",
    recentTranscript: "会议正在讨论推理优化。",
    settings: {
      modelProvider: "llama.cpp",
      llamaCppBaseUrl: baseUrl,
      llamaCppModel: "qwen3",
      searchApiKey: "test-key",
    },
    ...overrides,
  };
}

async function collectEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    events.push(JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>);
  }
  return events;
}

function findEvents(events: Array<Record<string, unknown>>, name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.event === name);
}

function answerFromChunks(events: Array<Record<string, unknown>>): string {
  let answer = "";
  for (const event of findEvents(events, "answer_chunk")) {
    const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
    answer += choices?.[0]?.delta?.content ?? "";
  }
  return answer;
}

// --- test cases ---

async function testSourcesOkAnswered(baseUrl: string): Promise<void> {
  const response = await POST(makeRequest(askBody(baseUrl)));
  const events = await collectEvents(response);

  const searching = findEvents(events, "searching");
  assert.equal(searching.length, 1, "应有且仅有一个 searching 事件");
  assert.ok(Array.isArray(searching[0].keywords) && (searching[0].keywords as string[]).length > 0);

  const chunks = findEvents(events, "answer_chunk");
  assert.ok(chunks.length > 0, "answered 用例应有 answer_chunk 流");
  assert.equal(
    answerFromChunks(events),
    "KV cache 通过复用已计算的键值对避免重复前向 [1][2]。",
    "流式回放内容必须等于校验后的 answer",
  );

  const done = findEvents(events, "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].finalState, "answered");
  assert.equal(done[0].cacheHit, false, "清缓存后首次调用不应命中缓存");
  const sources = done[0].sources as Array<{ title?: unknown; url?: unknown }>;
  assert.ok(Array.isArray(sources) && sources.length >= 2, "来源 ≥2");
  for (const source of sources) {
    assert.equal(typeof source.title, "string");
    assert.ok((source.title as string).length > 0);
    assert.equal(typeof source.url, "string");
    assert.ok((source.url as string).length > 0);
  }
}

async function testInsufficientSourcesDegradesWithoutGeneration(baseUrl: string): Promise<void> {
  const providerCallsBefore = providerBodies.length;
  const response = await POST(makeRequest(askBody(baseUrl, { question: "罕见术语 XQZ-9 是什么？" })));
  const events = await collectEvents(response);

  const degraded = findEvents(events, "degraded");
  assert.equal(degraded.length, 1, "来源不足应发出 degraded 事件");
  assert.ok(
    typeof degraded[0].message === "string" && (degraded[0].message as string).includes("没找到可靠来源"),
    "降级文案必须包含「没找到可靠来源」",
  );

  assert.equal(findEvents(events, "answer_chunk").length, 0, "降级用例不得有任何回答流");

  const done = findEvents(events, "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].finalState, "degraded");
  assert.deepEqual(done[0].sources, [], "降级用例无来源");

  // 不调生成：provider 只多了一次关键词提取调用，没有生成调用。
  assert.equal(
    providerBodies.length - providerCallsBefore,
    1,
    "来源不足时只允许关键词提取一次调用，不得调用生成（不编造）",
  );
}

async function testInvalidSchemaIsFailClosed(baseUrl: string): Promise<void> {
  const response = await POST(makeRequest(askBody(baseUrl, { question: "schema 违规场景的问题？" })));
  const events = await collectEvents(response);

  assert.equal(findEvents(events, "answer_chunk").length, 0, "schema 违规时不得回放任何伪造内容");

  const done = findEvents(events, "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].finalState, "invalid_schema", "schema 违规 → invalid_schema 终态");
  assert.equal((done[0].failure as { reason?: string })?.reason, "ask answer schema invalid");
}

async function testCacheHitSkipsSecondSearch(baseUrl: string): Promise<void> {
  const first = await POST(makeRequest(askBody(baseUrl, { question: "什么是 prefix caching？" })));
  await collectEvents(first);
  const searchCallsAfterFirst = searchLayerCalls.length;
  assert.ok(searchCallsAfterFirst > 0, "首次调用应触发搜索层");

  const second = await POST(makeRequest(askBody(baseUrl, { question: "什么是 prefix caching？" })));
  const events = await collectEvents(second);
  assert.equal(searchLayerCalls.length, searchCallsAfterFirst, "缓存命中：第二次同关键词不得再发搜索");

  const done = findEvents(events, "done");
  assert.equal(done.length, 1);
  assert.equal(done[0].finalState, "answered");
  assert.equal(done[0].cacheHit, true, "第二次调用 done 事件应标记 cacheHit");
}

async function testPrivacyTranscriptNeverLeavesToSearch(baseUrl: string): Promise<void> {
  const marker = "ZEBRAQ-7713";
  const searchCallsBefore = searchLayerCalls.length;
  const providerCallsBefore = providerBodies.length;

  const response = await POST(
    makeRequest(
      askBody(baseUrl, {
        question: "项目代号相关的机制是什么？",
        recentTranscript: `内部项目代号 ${marker} 的机密讨论：${marker} 的预算与排期只在会上口头同步。`,
      }),
    ),
  );
  const events = await collectEvents(response);
  assert.equal(findEvents(events, "done")[0]?.finalState, "answered", "隐私用例本身应跑通 answered 流程");

  // 外发红线：任何搜索层调用的 url/请求体不得包含转写片段。
  const searchCalls = searchLayerCalls.slice(searchCallsBefore);
  assert.ok(searchCalls.length > 0, "隐私用例应至少发生一次搜索层外发调用（否则断言无意义）");
  for (const call of searchCalls) {
    assert.ok(!call.url.includes(marker), `外发 url 泄漏转写标记词：${call.url}`);
    assert.ok(!call.body.includes(marker), `外发请求体泄漏转写标记词：${call.url}`);
  }

  // 录音证据：转写仅出现在本地 provider 的生成调用体中（本地推理上下文，非外发）。
  const newProviderBodies = providerBodies.slice(providerCallsBefore);
  assert.equal(newProviderBodies.length, 2, "answered 流程 = 关键词提取 + 生成两次本地调用");
  assert.ok(!newProviderBodies[0].includes(marker), "关键词提取调用不得携带转写");
  assert.ok(newProviderBodies[1].includes(marker), "生成调用（本地）应携带只读转写上下文");
}

// --- f) askPrompt 旧键迁移（localStorage 可注入 shim，无 jsdom 依赖）---

interface StorageShim {
  store: Map<string, string>;
  /** setItem 调用计数（幂等性断言用）。 */
  setCalls: number;
  install: () => void;
  uninstall: () => void;
}

function createStorageShim(seed: Record<string, string>): StorageShim {
  const store = new Map<string, string>(Object.entries(seed));
  let setCalls = 0;
  const shim = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      setCalls += 1;
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousLocalStorage = globals.localStorage;
  return {
    store,
    get setCalls(): number {
      return setCalls;
    },
    install: () => {
      globals.window = {};
      globals.localStorage = shim;
    },
    uninstall: () => {
      if (previousWindow === undefined) delete globals.window;
      else globals.window = previousWindow;
      if (previousLocalStorage === undefined) delete globals.localStorage;
      else globals.localStorage = previousLocalStorage;
    },
  };
}

function testAskPromptLegacyMigration(): void {
  const legacyPrompt = "LEGACY ASK PROMPT 旧契约（引用式回答）";
  const shim = createStorageShim({
    cuemind_settings: JSON.stringify({ chatPrompt: legacyPrompt }),
  });
  shim.install();
  try {
    const settings = loadCueMindSettings();
    assert.equal(settings.askPrompt, legacyPrompt, "旧 chatPrompt 值应迁入 askPrompt");

    // 一次性迁移：写回后的 blob 只含 askPrompt，不再保留 chatPrompt。
    const persistedRaw = shim.store.get("cuemind_settings");
    assert.ok(persistedRaw !== undefined, "迁移后应回写 cuemind_settings");
    const persisted = JSON.parse(persistedRaw as string) as Record<string, unknown>;
    assert.equal(persisted.askPrompt, legacyPrompt);
    assert.ok(!("chatPrompt" in persisted), "迁移后旧键 chatPrompt 应被清除");
  } finally {
    shim.uninstall();
  }
}

// 旧 chatPrompt 值 === 旧出厂默认（自由对话式契约）→ 丢弃旧默认，升级为新
// 引用式契约 ASK_PROMPT（冒烟 bug 根因：旧默认导致模型输出自由文本 →
// /api/ask invalid_schema）。
function testLegacyDefaultChatPromptUpgradesToCitationContract(): void {
  const shim = createStorageShim({
    cuemind_settings: JSON.stringify({ chatPrompt: LEGACY_DEFAULT_CHAT_PROMPT }),
  });
  shim.install();
  try {
    const settings = loadCueMindSettings();
    assert.equal(settings.askPrompt, ASK_PROMPT, "旧默认值 chatPrompt 应升级为新引用式契约默认");

    const persistedRaw = shim.store.get("cuemind_settings");
    assert.ok(persistedRaw !== undefined, "迁移后应回写 cuemind_settings");
    const persisted = JSON.parse(persistedRaw as string) as Record<string, unknown>;
    assert.equal(persisted.askPrompt, ASK_PROMPT, "回写 blob 的 askPrompt 应为新默认");
    assert.ok(!("chatPrompt" in persisted), "迁移后旧键 chatPrompt 应被清除");
  } finally {
    shim.uninstall();
  }
}

// 已迁移存储自愈：提交 1 的迁移已把旧默认写成 askPrompt 且删掉 chatPrompt，
// 此时存量 askPrompt === 旧默认 → 返回新默认并持久化修正，且修正幂等。
function testAlreadyMigratedLegacyDefaultSelfHeals(): void {
  const shim = createStorageShim({
    cuemind_settings: JSON.stringify({ askPrompt: LEGACY_DEFAULT_CHAT_PROMPT }),
  });
  shim.install();
  try {
    const settings = loadCueMindSettings();
    assert.equal(settings.askPrompt, ASK_PROMPT, "自愈场景应返回新引用式契约默认");

    const persistedRaw = shim.store.get("cuemind_settings");
    assert.ok(persistedRaw !== undefined, "自愈后应回写 cuemind_settings");
    const persisted = JSON.parse(persistedRaw as string) as Record<string, unknown>;
    assert.equal(persisted.askPrompt, ASK_PROMPT, "自愈应把修正后的新默认持久化");
    assert.ok(!("chatPrompt" in persisted));

    // 幂等：修正完成后再次加载不得再回写存储。
    const setCallsAfterHeal = shim.setCalls;
    const second = loadCueMindSettings();
    assert.equal(second.askPrompt, ASK_PROMPT);
    assert.equal(shim.setCalls, setCallsAfterHeal, "已自愈的存储再次加载不应再回写");
  } finally {
    shim.uninstall();
  }
}

// --- main ---

async function main(): Promise<void> {
  installSearchMock();
  try {
    // a) 来源 ≥2 → answered + sources 结构
    {
      askCacheClear();
      tavilyResultCount = 2;
      searchLayerCalls.length = 0;
      const script: ProviderScript = {
        keywords: ["KV Cache"],
        generationContent: JSON.stringify({
          answer: "KV cache 通过复用已计算的键值对避免重复前向 [1][2]。",
          sources: [
            { title: "KV Cache explained", url: "https://example.com/kv-cache" },
            { title: "Second source", url: "https://example.com/second" },
          ],
          confidence: "high",
        }),
      };
      const { server, baseUrl } = await startMockProvider(script);
      try {
        await testSourcesOkAnswered(baseUrl);
      } finally {
        await stopMockServer(server);
      }
      console.log("a) sources >= 2 → answered + sources(title/url) 通过");
    }

    // b) 来源 <2 → 不调生成、degraded 文案、无编造
    {
      askCacheClear();
      tavilyResultCount = 1;
      providerBodies.length = 0;
      const script: ProviderScript = {
        keywords: ["XQZ-9"],
        generationContent: "NEVER-SENT 编造内容",
      };
      const { server, baseUrl } = await startMockProvider(script);
      try {
        await testInsufficientSourcesDegradesWithoutGeneration(baseUrl);
      } finally {
        await stopMockServer(server);
      }
      console.log("b) sources < 2 → degraded（不调生成、无编造）通过");
    }

    // c) schema 违规 → invalid_schema 终态
    {
      askCacheClear();
      tavilyResultCount = 2;
      const script: ProviderScript = {
        keywords: ["schema"],
        // 缺 sources 字段 → validateAskAnswer 判违规。
        generationContent: JSON.stringify({ answer: "没有来源支撑的回答" }),
      };
      const { server, baseUrl } = await startMockProvider(script);
      try {
        await testInvalidSchemaIsFailClosed(baseUrl);
      } finally {
        await stopMockServer(server);
      }
      console.log("c) schema 违规 → invalid_schema（无伪造内容）通过");
    }

    // d) 缓存命中 → 第二次同关键词搜索 mock 计数不增加
    {
      askCacheClear();
      tavilyResultCount = 2;
      searchLayerCalls.length = 0;
      const script: ProviderScript = {
        keywords: ["prefix caching"],
        generationContent: JSON.stringify({
          answer: "prefix caching 复用公共前缀的 KV 计算 [1][2]。",
          sources: [
            { title: "KV Cache explained", url: "https://example.com/kv-cache" },
            { title: "Second source", url: "https://example.com/second" },
          ],
          confidence: "medium",
        }),
      };
      const { server, baseUrl } = await startMockProvider(script);
      try {
        await testCacheHitSkipsSecondSearch(baseUrl);
      } finally {
        await stopMockServer(server);
      }
      console.log("d) 缓存命中（搜索计数不增加 + cacheHit）通过");
    }

    // e) 隐私红线：转写片段不出现在任何外发（搜索层）调用
    {
      askCacheClear();
      tavilyResultCount = 2;
      const script: ProviderScript = {
        keywords: ["项目代号"],
        generationContent: JSON.stringify({
          answer: "机制说明 [1][2]。",
          sources: [
            { title: "KV Cache explained", url: "https://example.com/kv-cache" },
            { title: "Second source", url: "https://example.com/second" },
          ],
          confidence: "low",
        }),
      };
      const { server, baseUrl } = await startMockProvider(script);
      try {
        await testPrivacyTranscriptNeverLeavesToSearch(baseUrl);
      } finally {
        await stopMockServer(server);
      }
      console.log("e) 隐私红线（外发不含转写片段）通过");
    }

    // f) askPrompt 旧键迁移（纯 localStorage shim）：用户自定义旧值 → 保留
    testAskPromptLegacyMigration();
    console.log("f) askPrompt 旧键迁移（用户自定义 chatPrompt → 保留迁入 askPrompt）通过");

    // g) 旧 chatPrompt 值 === 旧出厂默认 → 升级为新引用式契约默认
    testLegacyDefaultChatPromptUpgradesToCitationContract();
    console.log("g) 旧默认 chatPrompt → 升级为新 ASK_PROMPT（丢弃旧默认）通过");

    // h) 已迁移存储自愈：askPrompt === 旧默认（chatPrompt 已删）→ 新默认 + 幂等持久化
    testAlreadyMigratedLegacyDefaultSelfHeals();
    console.log("h) 已迁移存储自愈（askPrompt=旧默认 → 新默认 + 幂等回写）通过");
  } finally {
    restoreFetch();
  }
  console.log("ask route regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
