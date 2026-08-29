// Live-ask history serialization shared by summarize (one-line Q&A context)
// and vault export (会中询问 section). Pure functions — no storage writes.

import type { AskSource, ChatMessage } from "@/types/chat";

export interface AskExchange {
  question: string;
  answer: string;
  sources?: AskSource[];
}

/** 单个问答字段（问题/答案）在拼接前保留的最长字符数。 */
export const MAX_ASK_FIELD_CHARS = 2_000;
/** 总结输入上下文中「会中询问」块的最长字符数（截断保护）。 */
export const MAX_ASK_CONTEXT_CHARS = 8_000;

/** 降级/失败回答的文案前缀（与 useAsk.ts 的上屏文案一致）。 */
export const DEGRADED_ANSWER_PREFIXES = [
  "没找到可靠来源",
  "回答生成失败",
] as const;

/** 内容是否为降级/失败文案（trim 后前缀匹配；覆盖 DB 回读无 isDegraded 标志的场景）。 */
export function isDegradedAnswerText(content: string): boolean {
  const trimmed = content.trim();
  return DEGRADED_ANSWER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * 从会话消息抽取完整问答对（user → 紧随的 assistant）。
 * 跳过：流式未定稿消息；降级/失败回答（isDegraded 或降级文案前缀）——
 * 这类回答不进入总结上下文、vault「会中询问」小节与训练信号。
 */
export function extractAskExchanges(
  messages: readonly ChatMessage[],
): AskExchange[] {
  const exchanges: AskExchange[] = [];
  let pendingQuestion: ChatMessage | null = null;
  for (const message of messages) {
    if (message.isStreaming) continue;
    if (message.role === "user") {
      pendingQuestion = message.content.trim().length > 0 ? message : null;
    } else if (message.role === "assistant" && pendingQuestion !== null) {
      const answer = message.content.trim();
      const degraded =
        message.isDegraded === true || isDegradedAnswerText(answer);
      if (answer.length > 0 && !degraded) {
        exchanges.push({
          question: pendingQuestion.content.trim(),
          answer,
          ...(message.sources && message.sources.length > 0
            ? { sources: message.sources }
            : {}),
        });
      }
      pendingQuestion = null;
    }
  }
  return exchanges;
}

/**
 * 一行拼接「问：… 答：…」，每个问答对一行；逐字段截断到 MAX_ASK_FIELD_CHARS，
 * 总长按整行粒度截断到 maxChars（避免截出残缺问答对）。
 */
export function formatAskExchangesOneLine(
  exchanges: readonly AskExchange[],
  maxChars: number = MAX_ASK_CONTEXT_CHARS,
): string {
  const lines: string[] = [];
  let length = 0;
  for (const exchange of exchanges) {
    const question = exchange.question.slice(0, MAX_ASK_FIELD_CHARS);
    const answer = exchange.answer.slice(0, MAX_ASK_FIELD_CHARS);
    if (question.length === 0 || answer.length === 0) continue;
    const line = `问：${question} 答：${answer}`;
    const appended = length === 0 ? line : `\n${line}`;
    if (length + appended.length > maxChars) break;
    lines.push(line);
    length += appended.length;
  }
  return lines.join("\n");
}