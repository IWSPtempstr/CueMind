import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  type JsonChatRequest,
} from "@/lib/model-provider";

/**
 * Local `llama.cpp`/`llama-server` provider. It wraps the shared
 * OpenAI-compatible JSON client and only supplies the `llama.cpp` identity.
 * All calls go through the app-side permit semaphore (`withLlamaSlot`) so the
 * per-call timeout budget covers model compute, not the wait for a permit.
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
 * App-side permit semaphore mirroring the deployment's llama-server parallel
 * slots (`-np 2`; permit count via `CUEMIND_LLAMA_SLOTS`, default 2, and must
 * match the server's `-np` to avoid silent server-side queuing).
 * llama-server serializes per slot, so without this semaphore a caller's wall
 * time silently includes the queue wait and its own timeout budget burns
 * before the model even starts (the main source of card-pipeline
 * `provider timed out`). Gating in the app makes the wait explicit and starts
 * each caller's timeout only once a permit is acquired.
 *
 * Callers may pass an `AbortSignal`: a caller that is aborted while still
 * queued is dequeued and rejected instead of later consuming a permit — dead
 * requests (client disconnected, watchdog fired) no longer burn a slot for
 * seconds. Aborts after acquisition are the caller's own business (its fetch
 * has its own timeout/watchdog).
 *
 * FIFO; not reentrant — callers must never issue a llama call from inside
 * another one (current routes never do). Kept on globalThis so dev-HMR /
 * duplicate module instances share one queue (same pattern as cardInflight).
 */

/** Number of llama-server parallel slots the app may occupy concurrently. */
export function llamaSlotPermits(): number {
  const raw = Number(process.env.CUEMIND_LLAMA_SLOTS ?? "2");
  return Number.isInteger(raw) && raw >= 1 ? raw : 2;
}

/**
 * Upper bound on how long a caller may sit in the queue before failing.
 * Queued callers cannot time themselves out (their budget signal is created
 * only after a permit is acquired — "budget starts after slot"), so without
 * this bound a leaked/slow permit hold chains into silent unbounded waits.
 * Expiry rejects with a queue-timeout error that routes map onto their
 * explicit failure terminal states (fail-closed).
 */
export function llamaSlotQueueTimeoutMs(): number {
  const raw = Number(process.env.CUEMIND_LLAMA_QUEUE_TIMEOUT_MS ?? "20000");
  return Number.isFinite(raw) && raw >= 1 ? raw : 20000;
}

export interface LlamaSlotOptions {
  signal?: AbortSignal;
}

interface LlamaSlotWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  /** Dequeues+rejects this waiter on abort; no-op once a permit was handed over. */
  onAbort: () => void;
  /** Clears the queue timeout once the waiter leaves the queue for any reason. */
  onDeque?: () => void;
}

interface LlamaSlotState {
  /** Permits currently held (0..llamaSlotPermits()). */
  active: number;
  /** Queued callers, in arrival order. */
  queue: Array<LlamaSlotWaiter>;
}
const globalLlamaSlot = globalThis as typeof globalThis & {
  cueMindLlamaSlot?: LlamaSlotState;
};
const llamaSlot: LlamaSlotState =
  globalLlamaSlot.cueMindLlamaSlot ?? { active: 0, queue: [] };
globalLlamaSlot.cueMindLlamaSlot = llamaSlot;

export async function withLlamaSlot<T>(
  fn: () => Promise<T>,
  options?: LlamaSlotOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) throw slotAbortedError();
  if (
    llamaSlot.active < llamaSlotPermits() &&
    llamaSlot.queue.length === 0
  ) {
    llamaSlot.active += 1;
  } else {
    let waiter: LlamaSlotWaiter | undefined;
    const queueTimeoutMs = llamaSlotQueueTimeoutMs();
    try {
      await new Promise<void>((resolve, reject) => {
        const entry: LlamaSlotWaiter = {
          resolve,
          reject,
          onAbort: () => {
            // Only act while still queued: a waiter the release() path already
            // shifted owns a permit and must not be rejected out from under it.
            const index = llamaSlot.queue.indexOf(entry);
            if (index === -1) return;
            llamaSlot.queue.splice(index, 1);
            reject(slotAbortedError());
          },
        };
        waiter = entry;
        llamaSlot.queue.push(entry);
        const queueTimer = setTimeout(() => {
          const index = llamaSlot.queue.indexOf(entry);
          if (index === -1) return;
          llamaSlot.queue.splice(index, 1);
          reject(slotQueueTimeoutError(queueTimeoutMs));
        }, queueTimeoutMs);
        queueTimer.unref?.();
        entry.onDeque = () => clearTimeout(queueTimer);
        signal?.addEventListener("abort", entry.onAbort, { once: true });
      });
    } finally {
      // 无论拿到槽还是排队中被 abort/超时，都摘掉监听，避免长生命周期 signal 泄漏。
      if (waiter !== undefined) {
        waiter.onDeque?.();
        signal?.removeEventListener("abort", waiter.onAbort);
      }
    }
    // A permit was handed over by release() (it already incremented `active`).
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

/** Distinctive rejection for callers that sat in the queue too long. */
function slotQueueTimeoutError(waitedMs: number): Error {
  const error = new Error(`llama slot queue timeout after ${waitedMs}ms`);
  error.name = "LlamaSlotQueueTimeoutError";
  return error;
}

function releaseLlamaSlot(): void {
  llamaSlot.active -= 1;
  const next = llamaSlot.queue.shift();
  if (next !== undefined) {
    // Hand the freed permit over synchronously (keep it counted as held
    // through the microtask handover so a concurrent fast-path caller cannot
    // over-subscribe the permits).
    llamaSlot.active += 1;
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
