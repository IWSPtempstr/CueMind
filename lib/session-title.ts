// Extracts a short discussion-topic phrase from a meeting transcript via the
// local llama.cpp provider. Shared by /api/session-title (thin shell) and the
// regression script, which injects a provider pointed at a mock HTTP server.

import {
  generateLlamaCppJson,
  llamaCppFailureMessage,
  resolveLocalProvider,
} from "@/lib/llama-cpp";

/** 提交给模型的转写窗口：只取末尾 ~4000 字符，前文对主题提取价值低。 */
const TRANSCRIPT_WINDOW_CHARS = 4000;

/** 主题短语长度上限（超长硬截断）。 */
export const SESSION_TITLE_MAX_CHARS = 20;

/** 本地 llama-server 的 JSON 调用超时。 */
export const SESSION_TITLE_TIMEOUT_MS = 8_000;

const SESSION_TITLE_SYSTEM_PROMPT =
  '从会议转写中提取一个讨论主题短语。只返回 JSON：{"topic":"..."}。主题不超过 20 个中文字符，不加标点结尾。';

/** Endpoint configuration accepted by buildSessionTitle (route resolves it via resolveLocalProvider). */
export type SessionTitleProvider = ReturnType<typeof resolveLocalProvider>;

/**
 * Calls the local provider and returns a trimmed topic phrase capped at
 * 20 characters. Throws a parameter error for an empty transcript and a
 * provider-failure message (llama.cpp failure wording) for upstream errors.
 */
export async function buildSessionTitle(
  transcript: string,
  provider: SessionTitleProvider = resolveLocalProvider(),
): Promise<string> {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    throw new Error("transcript is required");
  }

  const prompt =
    trimmedTranscript.length > TRANSCRIPT_WINDOW_CHARS
      ? trimmedTranscript.slice(-TRANSCRIPT_WINDOW_CHARS)
      : trimmedTranscript;

  let payload: unknown;
  try {
    payload = await generateLlamaCppJson<unknown>({
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: provider.apiKey,
      system: SESSION_TITLE_SYSTEM_PROMPT,
      prompt,
      timeoutMs: SESSION_TITLE_TIMEOUT_MS,
    });
  } catch (caught) {
    throw new Error(llamaCppFailureMessage(caught, "llama.cpp provider unavailable"));
  }

  const topic =
    typeof payload === "object" && payload !== null
      ? (payload as { topic?: unknown }).topic
      : undefined;
  if (typeof topic !== "string" || topic.trim().length === 0) {
    throw new Error("llama.cpp provider returned an invalid session title");
  }

  return topic.trim().slice(0, SESSION_TITLE_MAX_CHARS);
}
