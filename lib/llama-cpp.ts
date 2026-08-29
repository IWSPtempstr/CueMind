import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  type JsonChatRequest,
} from "@/lib/model-provider";

/**
 * Local `llama.cpp`/`llama-server` provider. It wraps the shared
 * OpenAI-compatible JSON client and only supplies the `llama.cpp` identity.
 */
export async function generateLlamaCppJson<T>(
  args: Omit<JsonChatRequest, "provider">,
): Promise<T> {
  if (!args.baseUrl.trim() || !args.model.trim()) {
    throw new ModelProviderError({
      provider: "llama.cpp",
      code: "model_unreachable",
    });
  }
  return generateOpenAiCompatibleJson<T>({ provider: "llama.cpp", ...args });
}

/** Endpoint configuration resolved for routes that call the local provider. */
export interface LocalLlamaCppProvider {
  baseUrl: string;
  model: string;
  /** Local llama-server needs no auth; kept empty so callers share one shape. */
  apiKey: string;
}

/**
 * Unified local provider resolution for chat/summarize/suggestions routes.
 * Prefers an optional request-body override
 * (`{ settings: { llamaCppBaseUrl, llamaCppModel } }`), then falls back to
 * `LLAMA_CPP_BASE_URL` / `LLAMA_CPP_MODEL`, then to the built-in defaults.
 */
export function resolveLocalProvider(
  requestBody?: unknown,
): LocalLlamaCppProvider {
  const root =
    typeof requestBody === "object" &&
    requestBody !== null &&
    !Array.isArray(requestBody)
      ? (requestBody as { settings?: unknown }).settings
      : null;
  const overrides =
    typeof root === "object" && root !== null && !Array.isArray(root)
      ? (root as { llamaCppBaseUrl?: unknown; llamaCppModel?: unknown })
      : null;
  const overrideString = (value: unknown): string =>
    typeof value === "string" && value.trim() ? value.trim() : "";

  return {
    baseUrl:
      overrideString(overrides?.llamaCppBaseUrl) ||
      process.env.LLAMA_CPP_BASE_URL?.trim() ||
      "http://127.0.0.1:8082/v1",
    model:
      overrideString(overrides?.llamaCppModel) ||
      process.env.LLAMA_CPP_MODEL?.trim() ||
      "cuemind-qwen3-4b-instruct-2507-q4_k_m",
    apiKey: "",
  };
}

/**
 * Maps provider failures onto the four failure classes (unreachable / timeout /
 * HTTP error / invalid JSON) using the same wording family as the
 * `providerFailureReason` mapper in the context-cards route. Never includes
 * upstream payloads, so no key or body content can leak through it.
 */
export function llamaCppFailureMessage(
  caught: unknown,
  fallback: string,
): string {
  if (caught instanceof ModelProviderError) {
    switch (caught.code) {
      case "model_unreachable":
        return "llama.cpp provider unreachable";
      case "model_timeout":
        return "llama.cpp provider timed out";
      case "model_http_error":
        return `llama.cpp provider HTTP ${caught.status ?? "error"}`;
      case "model_invalid_json":
        return "llama.cpp provider returned invalid JSON";
      case "model_schema_invalid":
        return "llama.cpp provider returned an invalid schema";
    }
  }
  return fallback;
}

/** True when a fetch rejected because its `AbortSignal.timeout` fired. */
export function isAbortTimeoutError(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "name" in caught &&
    (caught as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * Card-pipeline in-flight counter. Live asks yield to context-card generation
 * (red line 3): the ask route waits for this counter to drain before starting
 * its own model calls. Kept on globalThis so dev-HMR/duplicate module
 * instances share one counter (same pattern as the api-security rate limiter).
 */
const globalCardInflight = globalThis as typeof globalThis & {
  cueMindCardInflight?: { count: number };
};
export const cardInflight =
  globalCardInflight.cueMindCardInflight ?? { count: 0 };
globalCardInflight.cueMindCardInflight = cardInflight;

/** Counts fn as one in-flight card generation for the ask yield queue. */
export async function withCardInflight<T>(fn: () => Promise<T>): Promise<T> {
  cardInflight.count += 1;
  try {
    return await fn();
  } finally {
    cardInflight.count -= 1;
  }
}
