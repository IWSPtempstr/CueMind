import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolveLocalProvider } from "@/lib/llama-cpp";
import {
  SESSION_TITLE_MAX_CHARS,
  buildSessionTitle,
} from "@/lib/session-title";

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

function providerFor(baseUrl: string) {
  return resolveLocalProvider({
    settings: { llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" },
  });
}

const SAMPLE_TRANSCRIPT = "我们讨论了 Agent Harness 的设计，以及模型智能的上限。机甲比喻扩展了能力边界。";

// a) 正常返回：提取 topic 并 trim，同时校验请求到达 /v1/chat/completions 且提示词正确。
async function testSuccessfulTopic(): Promise<void> {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};

  const { server, baseUrl } = await startMockServer((req, res, body) => {
    requestUrl = req.url ?? "";
    requestBody = JSON.parse(body) as Record<string, unknown>;
    writeJson(res, 200, chatCompletion({ topic: "  Agent Harness 设计讨论  " }));
  });
  try {
    const topic = await buildSessionTitle(SAMPLE_TRANSCRIPT, providerFor(baseUrl));
    assert.equal(topic, "Agent Harness 设计讨论");
    assert.equal(requestUrl, "/v1/chat/completions");
    assert.equal(requestBody.model, "qwen3");
    const messages = requestBody.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /讨论主题短语/);
    assert.match(messages[0].content, /20 个中文字符/);
    assert.equal(messages[1].role, "user");
    assert.equal(messages[1].content, SAMPLE_TRANSCRIPT);
  } finally {
    await stopMockServer(server);
  }
}

// b) topic 超过 20 字 → 硬截断到 20。
async function testTopicTruncatedToMaxChars(): Promise<void> {
  const longTopic = "这是一个超过二十个中文字符的主题短语用来测试硬截断逻辑";
  assert.ok(longTopic.length > SESSION_TITLE_MAX_CHARS);

  const { server, baseUrl } = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ topic: longTopic }));
  });
  try {
    const topic = await buildSessionTitle(SAMPLE_TRANSCRIPT, providerFor(baseUrl));
    assert.equal(topic, longTopic.slice(0, SESSION_TITLE_MAX_CHARS));
    assert.equal(topic.length, SESSION_TITLE_MAX_CHARS);
  } finally {
    await stopMockServer(server);
  }
}

// c) provider 失败：HTTP 500 与无效 assistant JSON 均应抛错（路由转 502）。
async function testProviderFailures(): Promise<void> {
  const httpErrorServer = await startMockServer((_req, res) => {
    writeJson(res, 500, { error: { message: "boom" } });
  });
  try {
    await assert.rejects(
      buildSessionTitle(SAMPLE_TRANSCRIPT, providerFor(httpErrorServer.baseUrl)),
      (error: unknown) => error instanceof Error && error.message === "llama.cpp provider HTTP 500",
    );
  } finally {
    await stopMockServer(httpErrorServer.server);
  }

  const invalidJsonServer = await startMockServer((_req, res) => {
    writeJson(res, 200, { choices: [{ message: { content: "this is not json" } }] });
  });
  try {
    await assert.rejects(
      buildSessionTitle(SAMPLE_TRANSCRIPT, providerFor(invalidJsonServer.baseUrl)),
      (error: unknown) =>
        error instanceof Error && error.message === "llama.cpp provider returned invalid JSON",
    );
  } finally {
    await stopMockServer(invalidJsonServer.server);
  }

  // schema 无效：topic 缺失或非字符串同样按 provider 失败处理。
  const invalidSchemaServer = await startMockServer((_req, res) => {
    writeJson(res, 200, chatCompletion({ keyword: "KV Cache" }));
  });
  try {
    await assert.rejects(
      buildSessionTitle(SAMPLE_TRANSCRIPT, providerFor(invalidSchemaServer.baseUrl)),
      (error: unknown) =>
        error instanceof Error && error.message === "llama.cpp provider returned an invalid session title",
    );
  } finally {
    await stopMockServer(invalidSchemaServer.server);
  }
}

// d) 空 transcript → 参数错误（路由侧转 400）。
async function testEmptyTranscriptRejected(): Promise<void> {
  await assert.rejects(
    buildSessionTitle(""),
    (error: unknown) => error instanceof Error && error.message === "transcript is required",
  );
  await assert.rejects(
    buildSessionTitle("   \n\t  "),
    (error: unknown) => error instanceof Error && error.message === "transcript is required",
  );
}

// 附加：超长转写只取末尾 ~4000 字符作为 prompt。
async function testPromptWindowUsesTailOfTranscript(): Promise<void> {
  let userPrompt = "";
  const { server, baseUrl } = await startMockServer((_req, res, body) => {
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    userPrompt = parsed.messages[1]?.content ?? "";
    writeJson(res, 200, chatCompletion({ topic: "长转写主题" }));
  });
  try {
    const head = "开头上下文。".repeat(1000); // 6000 字符
    const tail = "结尾讨论了 KV Cache 的优化。";
    const topic = await buildSessionTitle(head + tail, providerFor(baseUrl));
    assert.equal(topic, "长转写主题");
    assert.equal(userPrompt.length, 4000);
    assert.ok(userPrompt.endsWith(tail));
    assert.ok(!userPrompt.startsWith("开头上下文。"));
  } finally {
    await stopMockServer(server);
  }
}

async function main(): Promise<void> {
  await testSuccessfulTopic();
  await testTopicTruncatedToMaxChars();
  await testProviderFailures();
  await testEmptyTranscriptRejected();
  await testPromptWindowUsesTailOfTranscript();
  console.log("session title route regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
