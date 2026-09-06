import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  type JsonChatRequest,
} from "@/lib/model-provider";

/**
 * Local `llama.cpp`/`llama-server` provider. It wraps the shared
 * OpenAI-compatible JSON client and only supplies the `llama.cpp` identity.
 * All calls go through the app-side single-slot queue (`withLlamaSlot`) so the
 * per-call timeout budget covers model compute, not the wait for the slot.
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
  return withLlamaSlot(() =>
    generateOpenAiCompatibleJson<T>({ provider: "llama.cpp", ...args }),
  );
}

/**
 * App-side queue mirroring the deployment's single llama-server slot
 * (`-np 1`; 8B fully offloaded on 8GB VRAM cannot raise it without OOM).
 * llama-server serializes concurrent requests internally, so without this
 * queue a caller's wall time silently includes the queue wait and its own
 * timeout budget burns before the model even starts (the main source of
 * card-pipeline `provider timed out`). Serializing in the app makes the wait
 * explicit and starts each caller's timeout only once the slot is acquired.
 *
 * Callers may pass an `AbortSignal`: a caller that is aborted while still
 * queued is dequeued and rejected instead of later consuming the slot — dead
 * requests (client disconnected, watchdog fired) no longer burn the single
 * slot for seconds. Aborts after slot acquisition are the caller's own
 * business (its fetch has its own timeout/watchdog).
 *
 * FIFO; not reentrant — callers must never issue a llama call from inside
 * another one (current routes never do). Kept on globalThis so dev-HMR /
 * duplicate module instances share one queue (same pattern as cardInflight).
 */
export interface LlamaSlotOptions {
  signal?: AbortSignal;
}

interface LlamaSlotWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  /** Dequeues+rejects this waiter on abort; no-op once the slot was handed over. */
  onAbort: () => void;
}

interface LlamaSlotState {
  busy: boolean;
  /** Queued callers, in arrival order. */
  queue: Array<LlamaSlotWaiter>;
}
const globalLlamaSlot = globalThis as typeof globalThis & {
  cueMindLlamaSlot?: LlamaSlotState;
};
const llamaSlot: LlamaSlotState =
  globalLlamaSlot.cueMindLlamaSlot ?? { busy: false, queue: [] };
globalLlamaSlot.cueMindLlamaSlot = llamaSlot;

export async function withLlamaSlot<T>(
  fn: () => Promise<T>,
  options?: LlamaSlotOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) throw slotAbortedError();
  if (llamaSlot.busy || llamaSlot.queue.length > 0) {
    let waiter: LlamaSlotWaiter | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const entry: LlamaSlotWaiter = {
          resolve,
          reject,
          onAbort: () => {
            // Only act while still queued: a waiter the release() path already
            // shifted owns the slot and must not be rejected out from under it.
            const index = llamaSlot.queue.indexOf(entry);
            if (index === -1) return;
            llamaSlot.queue.splice(index, 1);
            reject(slotAbortedError());
          },
        };
        waiter = entry;
        llamaSlot.queue.push(entry);
        signal?.addEventListener("abort", entry.onAbort, { once: true });
      });
    } finally {
      // 无论拿到槽还是排队中被 abort，都摘掉监听，避免长生命周期 signal 泄漏。
      if (waiter !== undefined) {
        signal?.removeEventListener("abort", waiter.onAbort);
      }
    }
    // The slot was handed over by release() with busy left true.
  } else {
    llamaSlot.busy = true;
  }
  try {
    return await fn();
  } finally {
    releaseLlamaSlot();
  }
}

/** AbortError-shaped rejection for callers dequeued by their own signal. */
function slotAbortedError(): Error {
  const error = new Error("Aborted while waiting for the llama slot");
  error.name = "AbortError";
  return error;
}

function releaseLlamaSlot(): void {
  const next = llamaSlot.queue.shift();
  if (next === undefined) {
    llamaSlot.busy = false;
  } else {
    // Keep busy=true through the microtask handover so a concurrent fast-path
    // caller cannot double-own the slot.
    next.resolve();
  }
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

/**
 * True while any context-card pipeline work (keyword extraction or generation)
 * is in flight. Periodic tasks (suggestions / summarize) check this before
 * calling the local model and yield for the current tick instead of contending
 * with the card pipeline for a single-slot llama-server, which otherwise pushes
 * the card pipeline past its 5s/8s budget and makes it time out.
 */
export function cardPipelineInFlight(): boolean {
  return cardInflight.count > 0;
}
