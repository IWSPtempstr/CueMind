import assert from "node:assert/strict";
import {
  ModelProviderError,
  isModelProviderErrorCode,
  isModelProviderName,
  serializeModelProviderError,
  type ModelProviderErrorCode,
  type ModelProviderName,
} from "@/lib/model-provider";
import type { Settings } from "@/types/settings";

const API_KEY = "test-api-key-must-not-leak";

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

testProviderNames();
testErrorCodes();
testSafeErrorSerialization();
testErrorValidation();
testSettingsContract();

console.log("model provider regression tests passed");
