export const MODEL_PROVIDER_NAMES = ["llama.cpp", "remote-api"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export const MODEL_PROVIDER_ERROR_CODES = [
  "model_unreachable",
  "model_timeout",
  "model_http_error",
  "model_invalid_json",
  "model_schema_invalid",
] as const;

export type ModelProviderErrorCode =
  (typeof MODEL_PROVIDER_ERROR_CODES)[number];

export const MODEL_PROVIDER_FAILURE_CODES = [
  "http_error",
  "timeout",
  "network_error",
  "invalid_json",
  "empty_response",
] as const;

export type ModelProviderFailureCode =
  (typeof MODEL_PROVIDER_FAILURE_CODES)[number];

export const MODEL_PROVIDER_ERROR_STAGES = ["request", "response"] as const;

export type ModelProviderErrorStage =
  (typeof MODEL_PROVIDER_ERROR_STAGES)[number];

export interface SerializedModelProviderError {
  name: "ModelProviderError";
  provider: ModelProviderName;
  code: ModelProviderErrorCode;
  failureCode?: ModelProviderFailureCode;
  stage?: ModelProviderErrorStage;
  status?: number;
  message: string;
}

export interface ModelProviderErrorOptions {
  provider: ModelProviderName;
  code: ModelProviderErrorCode;
  failureCode?: ModelProviderFailureCode;
  stage?: ModelProviderErrorStage;
  status?: number;
  detail?: unknown;
}

const SAFE_ERROR_MESSAGE = "Model provider request failed.";

export function isModelProviderName(
  value: unknown,
): value is ModelProviderName {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_NAMES as readonly string[]).includes(value)
  );
}

export function isModelProviderErrorCode(
  value: unknown,
): value is ModelProviderErrorCode {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function isModelProviderFailureCode(
  value: unknown,
): value is ModelProviderFailureCode {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_FAILURE_CODES as readonly string[]).includes(value)
  );
}

export class ModelProviderError extends Error {
  readonly provider: ModelProviderName;
  readonly code: ModelProviderErrorCode;
  readonly failureCode?: ModelProviderFailureCode;
  readonly stage?: ModelProviderErrorStage;
  readonly status?: number;

  constructor(options: ModelProviderErrorOptions) {
    if (!isModelProviderName(options.provider)) {
      throw new TypeError("Invalid model provider.");
    }
    if (!isModelProviderErrorCode(options.code)) {
      throw new TypeError("Invalid model provider error code.");
    }
    if (
      options.failureCode !== undefined &&
      !isModelProviderFailureCode(options.failureCode)
    ) {
      throw new TypeError("Invalid model provider failure code.");
    }
    if (
      options.stage !== undefined &&
      !MODEL_PROVIDER_ERROR_STAGES.includes(options.stage)
    ) {
      throw new TypeError("Invalid model provider error stage.");
    }
    if (
      options.status !== undefined &&
      (!Number.isInteger(options.status) ||
        options.status < 100 ||
        options.status > 599)
    ) {
      throw new TypeError("Invalid model provider HTTP status.");
    }

    super(SAFE_ERROR_MESSAGE);
    this.name = "ModelProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.failureCode = options.failureCode;
    this.stage = options.stage;
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedModelProviderError {
    return serializeModelProviderError(this);
  }
}

export function serializeModelProviderError(
  error: ModelProviderError,
): SerializedModelProviderError {
  const serialized: SerializedModelProviderError = {
    name: "ModelProviderError",
    provider: error.provider,
    code: error.code,
    message: SAFE_ERROR_MESSAGE,
  };

  if (error.failureCode !== undefined) {
    serialized.failureCode = error.failureCode;
  }
  if (error.stage !== undefined) {
    serialized.stage = error.stage;
  }

  if (error.status !== undefined) {
    serialized.status = error.status;
  }

  return serialized;
}

// --- OpenAI-compatible JSON chat client ---

export interface JsonChatRequest {
  provider: ModelProviderName;
  baseUrl: string;
  model: string;
  apiKey?: string;
  system: string;
  prompt: string;
  timeoutMs: number;
  /** Optional output token cap forwarded as `max_tokens` when provided. */
  maxTokens?: number;
  /**
   * Optional JSON Schema forwarded to llama-server as a `json_schema`
   * response_format so the grammar sampler constrains the output shape at
   * decode time (zero-latency structural guarantee; only applied for the
   * local llama.cpp provider — arbitrary OpenAI-compatible endpoints may
   * not accept `json_schema` response formats).
   */
  jsonSchema?: unknown;
}

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const withV1 = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${withV1}/chat/completions`;
}

/**
 * Calls an OpenAI-compatible `/v1/chat/completions` endpoint and returns the
 * assistant message content parsed as JSON. Throws `ModelProviderError` with a
 * typed `code` for unreachable, timeout, HTTP/auth, and invalid-JSON failures.
 */
export async function generateOpenAiCompatibleJson<T>(
  request: JsonChatRequest,
): Promise<T> {
  const url = normalizeChatCompletionsUrl(request.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await postChatCompletions(url, request, controller.signal);
    if (!response.ok) {
      throw new ModelProviderError({
        provider: request.provider,
        code: "model_http_error",
        failureCode: "http_error",
        stage: "response",
        status: response.status,
      });
    }
    return await parseChatCompletionsJson<T>(response, request.provider);
  } catch (caught) {
    if (caught instanceof ModelProviderError) {
      throw caught;
    }
    if (isAbortError(caught)) {
      throw new ModelProviderError({
        provider: request.provider,
        code: "model_timeout",
        failureCode: "timeout",
        stage: "request",
      });
    }
    throw new ModelProviderError({
      provider: request.provider,
      code: "model_unreachable",
      failureCode: "network_error",
      stage: "request",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function postChatCompletions(
  url: string,
  request: JsonChatRequest,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (request.apiKey && request.apiKey.length > 0) {
    headers.Authorization = `Bearer ${request.apiKey}`;
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      temperature: 0,
      // GBNF-constrained decoding: llama-server accepts a full JSON Schema via
      // response_format and enforces it during sampling, making schema-invalid
      // output structurally impossible (validation stays as defense-in-depth).
      // Gated to the local provider: remote endpoints may reject json_schema.
      ...(request.jsonSchema !== undefined && request.provider === "llama.cpp"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { schema: request.jsonSchema },
            },
          }
        : { response_format: { type: "json_object" } }),
      ...(request.maxTokens !== undefined
        ? { max_tokens: request.maxTokens }
        : {}),
    }),
    signal,
    cache: "no-store",
  });
}

async function parseChatCompletionsJson<T>(
  response: Response,
  provider: ModelProviderName,
): Promise<T> {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    throw new ModelProviderError({
      provider,
      code: "model_invalid_json",
      failureCode: "invalid_json",
      stage: "response",
    });
  }

  if (rawBody.trim().length === 0) {
    throw new ModelProviderError({
      provider,
      code: "model_invalid_json",
      failureCode: "empty_response",
      stage: "response",
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ModelProviderError({
      provider,
      code: "model_invalid_json",
      failureCode: "invalid_json",
      stage: "response",
    });
  }

  const content = extractChatAssistantContent(payload);
  if (content === null || content.trim().length === 0) {
    throw new ModelProviderError({
      provider,
      code: "model_invalid_json",
      failureCode: content === null ? "invalid_json" : "empty_response",
      stage: "response",
    });
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new ModelProviderError({
      provider,
      code: "model_invalid_json",
      failureCode: "invalid_json",
      stage: "response",
    });
  }
}

export function extractChatAssistantContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = root.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { name?: unknown }).name === "AbortError"
  );
}
