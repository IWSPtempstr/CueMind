import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  isModelProviderErrorCode,
  isModelProviderName,
  serializeModelProviderError,
  type ModelProviderErrorCode,
  type ModelProviderName,
} from "@/lib/model-provider";
import { generateLlamaCppJson } from "@/lib/llama-cpp";
import { generateRemoteApiJson } from "@/lib/remote-api";
import { getDefaultSettings, loadCueMindSettings } from "@/hooks/useSettings";
import type { Settings } from "@/types/settings";

const API_KEY = "test-api-key-must-not-leak";
const BEARER_KEY = "sk-test-bearer";

function expectThrows(action: () => unknown, message: string): void {
  assert.throws(action, message);
}

function testProviderNames(): void {
  assert.equal(isModelProviderName("llama.cpp"), true);
  assert.equal(isModelProviderName("remote-api"), true);
  assert.equal(isModelProviderName("unsupported-provider"), false);
  assert.equal(isModelProviderName(""), false);
}

function testErrorCodes(): void {
  const codes: ModelProviderErrorCode[] = [
    "model_unreachable",
    "model_timeout",
    "model_http_error",
    "model_invalid_json",
    "model_schema_invalid",
  ];

  for (const code of codes) {
    assert.equal(isModelProviderErrorCode(code), true);
  }

  assert.equal(isModelProviderErrorCode("unknown_error"), false);
}

function testSafeErrorSerialization(): void {
  const error = new ModelProviderError({
    provider: "remote-api",
    code: "model_http_error",
    status: 401,
    detail: `request failed with key ${API_KEY}`,
  });
  const serialized = serializeModelProviderError(error);

  assert.deepEqual(serialized, {
    name: "ModelProviderError",
    provider: "remote-api",
    code: "model_http_error",
    status: 401,
    message: "Model provider request failed.",
  });
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal(JSON.stringify(error).includes(API_KEY), false);
  assert.equal(JSON.stringify(serialized).includes(API_KEY), false);
  assert.equal(Object.keys(error).includes("apiKey"), false);
  assert.equal(Object.keys(error).includes("detail"), false);
}

function testErrorValidation(): void {
  expectThrows(
    () =>
      new ModelProviderError({
        provider: "unsupported-provider" as ModelProviderName,
        code: "model_timeout",
      }),
    "invalid provider must be rejected",
  );
  expectThrows(
    () =>
      new ModelProviderError({
        provider: "llama.cpp",
        code: "unknown_error" as ModelProviderErrorCode,
      }),
    "invalid error code must be rejected",
  );
}

function testSettingsContract(): void {
  const settings = {} as Settings;
  settings.modelProvider = "llama.cpp";
  settings.llamaCppBaseUrl = "http://127.0.0.1:8080";
  settings.llamaCppModel = "qwen3";
  settings.llamaCppApiKey = "";
  settings.remoteApiBaseUrl = "https://example.invalid";
  settings.remoteApiModel = "remote-model";
  settings.remoteApiApiKey = "";

  assert.equal(settings.modelProvider, "llama.cpp");
  assert.equal(settings.remoteApiModel, "remote-model");
}

// --- P1.2 OpenAI-compatible JSON client (local mock HTTP server) ---

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

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

async function withMockServer(
  handler: MockHandler,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = await startMockServer(handler);
  try {
    await run(baseUrl);
  } finally {
    await stopMockServer(server);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function chatCompletionBody(content: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

async function testSuccessfulJsonResponse(): Promise<void> {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};

  await withMockServer((req, res, body) => {
    requestUrl = req.url ?? "";
    requestBody = JSON.parse(body) as Record<string, unknown>;
    writeJson(res, 200, chatCompletionBody({ keyword: "KV Cache" }));
  }, async (baseUrl) => {
    const result = await generateOpenAiCompatibleJson<{ keyword: string }>({
      provider: "llama.cpp",
      baseUrl,
      model: "qwen3",
      system: "system text",
      prompt: "user text",
      timeoutMs: 1_000,
    });
    assert.equal(result.keyword, "KV Cache");
  });

  assert.equal(requestUrl, "/v1/chat/completions");
  assert.equal(requestBody.model, "qwen3");
  assert.equal(requestBody.temperature, 0);
  const messages = requestBody.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "system text");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, "user text");
  const responseFormat = requestBody.response_format as { type: string };
  assert.equal(responseFormat.type, "json_object");
}

async function testBaseUrlNormalizationWithV1Suffix(): Promise<void> {
  let requestUrl = "";
  await withMockServer((req, res) => {
    requestUrl = req.url ?? "";
    writeJson(res, 200, chatCompletionBody({ ok: true }));
  }, async (baseUrl) => {
    await generateOpenAiCompatibleJson({
      provider: "llama.cpp",
      baseUrl: `${baseUrl}/v1`,
      model: "m",
      system: "s",
      prompt: "p",
      timeoutMs: 1_000,
    });
  });
  assert.equal(requestUrl, "/v1/chat/completions");
}

async function testNon2xxResponse(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 401, { error: { message: "unauthorized" } });
  }, async (baseUrl) => {
    await assert.rejects(
      generateOpenAiCompatibleJson({
        provider: "remote-api",
        baseUrl,
        model: "m",
        system: "s",
        prompt: "p",
        timeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.code === "model_http_error" &&
        error.status === 401,
    );
  });
}

async function testTimeout(): Promise<void> {
  await withMockServer((_req, res) => {
    setTimeout(() => {
      if (!res.destroyed && !res.writableEnded) {
        writeJson(res, 200, chatCompletionBody({ ok: true }));
      }
    }, 150);
  }, async (baseUrl) => {
    await assert.rejects(
      generateOpenAiCompatibleJson({
        provider: "llama.cpp",
        baseUrl,
        model: "m",
        system: "s",
        prompt: "p",
        timeoutMs: 50,
      }),
      (error: unknown) =>
        error instanceof ModelProviderError && error.code === "model_timeout",
    );
  });
}

async function testInvalidAssistantJson(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 200, { choices: [{ message: { content: "this is not json" } }] });
  }, async (baseUrl) => {
    await assert.rejects(
      generateOpenAiCompatibleJson({
        provider: "llama.cpp",
        baseUrl,
        model: "m",
        system: "s",
        prompt: "p",
        timeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof ModelProviderError && error.code === "model_invalid_json",
    );
  });
}

async function testMissingAssistantContent(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 200, { choices: [] });
  }, async (baseUrl) => {
    await assert.rejects(
      generateOpenAiCompatibleJson({
        provider: "llama.cpp",
        baseUrl,
        model: "m",
        system: "s",
        prompt: "p",
        timeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof ModelProviderError && error.code === "model_invalid_json",
    );
  });
}

async function testNoAuthHeaderForEmptyKey(): Promise<void> {
  let authHeader: string | undefined;
  await withMockServer((req, res) => {
    authHeader = req.headers.authorization;
    writeJson(res, 200, chatCompletionBody({ ok: true }));
  }, async (baseUrl) => {
    await generateOpenAiCompatibleJson({
      provider: "llama.cpp",
      baseUrl,
      model: "m",
      system: "s",
      prompt: "p",
      timeoutMs: 1_000,
      apiKey: "",
    });
  });
  assert.equal(authHeader, undefined);
}

async function testBearerHeaderForNonEmptyKey(): Promise<void> {
  let authHeader: string | undefined;
  await withMockServer((req, res) => {
    authHeader = req.headers.authorization;
    writeJson(res, 200, chatCompletionBody({ ok: true }));
  }, async (baseUrl) => {
    await generateOpenAiCompatibleJson({
      provider: "remote-api",
      baseUrl,
      model: "m",
      system: "s",
      prompt: "p",
      timeoutMs: 1_000,
      apiKey: BEARER_KEY,
    });
  });
  assert.equal(authHeader, `Bearer ${BEARER_KEY}`);
}

// --- P1.3 provider wrappers ---

async function testLlamaCppWrapperSuccess(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 200, chatCompletionBody({ keyword: "KV Cache" }));
  }, async (baseUrl) => {
    const result = await generateLlamaCppJson<{ keyword: string }>({
      baseUrl,
      model: "qwen3",
      system: "s",
      prompt: "p",
      timeoutMs: 1_000,
    });
    assert.equal(result.keyword, "KV Cache");
  });
}

async function testWrapperProviderIdentity(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 500, { error: { message: "server error" } });
  }, async (baseUrl) => {
    const args = { baseUrl, model: "m", system: "s", prompt: "p", timeoutMs: 1_000 };
    await assert.rejects(
      generateLlamaCppJson(args),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.provider === "llama.cpp" &&
        error.code === "model_http_error" &&
        error.status === 500,
    );
    await assert.rejects(
      generateRemoteApiJson(args),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.provider === "remote-api" &&
        error.code === "model_http_error" &&
        error.status === 500,
    );
  });
}

async function testWrapperRejectsEmptyConfig(): Promise<void> {
  await assert.rejects(
    generateLlamaCppJson({ baseUrl: "", model: "m", system: "s", prompt: "p", timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.provider === "llama.cpp" &&
      error.code === "model_unreachable",
  );
  await assert.rejects(
    generateLlamaCppJson({ baseUrl: "http://127.0.0.1:1", model: " ", system: "s", prompt: "p", timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.provider === "llama.cpp" &&
      error.code === "model_unreachable",
  );
  await assert.rejects(
    generateRemoteApiJson({ baseUrl: "", model: "m", system: "s", prompt: "p", timeoutMs: 1_000 }),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.provider === "remote-api" &&
      error.code === "model_unreachable",
  );
}

async function testWrapperNoApiKeyLeak(): Promise<void> {
  await withMockServer((_req, res) => {
    writeJson(res, 200, { choices: [{ message: { content: "not-json" } }] });
  }, async (baseUrl) => {
    await assert.rejects(
      generateRemoteApiJson({
        baseUrl,
        model: "m",
        system: "s",
        prompt: "p",
        timeoutMs: 1_000,
        apiKey: API_KEY,
      }),
      (error: unknown) => {
        if (!(error instanceof ModelProviderError)) return false;
        return (
          error.code === "model_invalid_json" &&
          error.message.includes(API_KEY) === false &&
          JSON.stringify(error).includes(API_KEY) === false
        );
      },
    );
  });
}

// --- P1.4 settings defaults and migration ---

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeMemoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

function withBrowserGlobals(local: MemoryStorage, session: MemoryStorage, run: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevLocal = g.localStorage;
  const prevSession = g.sessionStorage;
  g.window = {};
  g.localStorage = local;
  g.sessionStorage = session;
  try {
    run();
  } finally {
    if (prevWindow === undefined) delete g.window; else g.window = prevWindow;
    if (prevLocal === undefined) delete g.localStorage; else g.localStorage = prevLocal;
    if (prevSession === undefined) delete g.sessionStorage; else g.sessionStorage = prevSession;
  }
}

function testDefaultSettings(): void {
  const defaults = getDefaultSettings();
  assert.equal(defaults.modelProvider, "llama.cpp");
  assert.equal(defaults.llamaCppBaseUrl, "http://127.0.0.1:8082");
  assert.equal(defaults.llamaCppModel, "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf");
  assert.equal(defaults.llamaCppApiKey, "");
  assert.equal(defaults.remoteApiBaseUrl, "");
  assert.equal(defaults.remoteApiModel, "");
  assert.equal(defaults.remoteApiApiKey, "");
}

function testSettingsMigration(): void {
  const local = makeMemoryStorage();
  const session = makeMemoryStorage();
  local.setItem("cuemind_settings", JSON.stringify({
    ollamaBaseUrl: "http://custom-host:11434",
    ollamaModel: "custom-ollama-model",
    searchProvider: "bing",
  }));
  local.setItem("cuemind_llama_cpp_api_key", "llama-secret");

  withBrowserGlobals(local, session, () => {
    const settings = loadCueMindSettings();
    assert.equal(settings.modelProvider, "llama.cpp");
    assert.equal(settings.llamaCppBaseUrl, "http://custom-host:11434");
    assert.equal(settings.llamaCppModel, "custom-ollama-model");
    assert.equal(settings.searchProvider, "bing");
    assert.equal(settings.llamaCppApiKey, "llama-secret");

    const persisted = JSON.parse(local.getItem("cuemind_settings") ?? "{}") as Record<string, unknown>;
    assert.equal("llamaCppApiKey" in persisted, false);
    assert.equal("ollamaBaseUrl" in persisted, false);
    assert.equal("ollamaModel" in persisted, false);
    assert.equal(persisted.llamaCppBaseUrl, "http://custom-host:11434");
  });
}

async function main(): Promise<void> {
  testProviderNames();
  testErrorCodes();
  testSafeErrorSerialization();
  testErrorValidation();
  testSettingsContract();

  await testSuccessfulJsonResponse();
  await testBaseUrlNormalizationWithV1Suffix();
  await testNon2xxResponse();
  await testTimeout();
  await testInvalidAssistantJson();
  await testMissingAssistantContent();
  await testNoAuthHeaderForEmptyKey();
  await testBearerHeaderForNonEmptyKey();

  await testLlamaCppWrapperSuccess();
  await testWrapperProviderIdentity();
  await testWrapperRejectsEmptyConfig();
  await testWrapperNoApiKeyLeak();

  testDefaultSettings();
  testSettingsMigration();

  console.log("model provider regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
