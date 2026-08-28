// 与主项目保持同步的只读视图：
// - TranscriptChunk 形状对应主项目 types/session.ts 的同名接口（JSON 序列化后 timestamp 为字符串），
//   另含主项目 lib/session-store.ts transcriptText 的同款实现（chunk.text 以 "\n" 连接）。
// - 对外返回 chunk 时走 toPublicChunk 白名单：不暴露 latency（trace payload）、音频与密钥类字段（决策 62）。

export interface TranscriptChunk {
  id?: string;
  text?: string;
  timestamp?: string;
  source?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  [key: string]: unknown;
}

export interface PublicTranscriptChunk {
  id?: string;
  text?: string;
  timestamp?: string;
  source?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
}

/** 宽容解析 transcriptJson：非数组/坏 JSON 一律返回 []（只读场景不修复数据）。 */
export function parseTranscriptChunks(transcriptJson: string): TranscriptChunk[] {
  try {
    const parsed: unknown = JSON.parse(transcriptJson);
    if (!Array.isArray(parsed)) return [];
    const chunks: TranscriptChunk[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      chunks.push(item as TranscriptChunk);
    }
    return chunks;
  } catch {
    return [];
  }
}

/** 与主项目 lib/session-store.ts 的 transcriptText 保持同步。 */
export function transcriptText(transcriptJson: string): string {
  const chunks = parseTranscriptChunks(transcriptJson);
  const texts: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk.text === "string") texts.push(chunk.text);
  }
  return texts.join("\n");
}

/** 白名单字段输出：丢弃 latency 等 trace/扩展字段。 */
export function toPublicChunk(chunk: TranscriptChunk): PublicTranscriptChunk {
  const output: PublicTranscriptChunk = {};
  if (typeof chunk.id === "string") output.id = chunk.id;
  if (typeof chunk.text === "string") output.text = chunk.text;
  if (typeof chunk.timestamp === "string") output.timestamp = chunk.timestamp;
  if (typeof chunk.source === "string") output.source = chunk.source;
  if (typeof chunk.startMs === "number") output.startMs = chunk.startMs;
  if (typeof chunk.endMs === "number") output.endMs = chunk.endMs;
  if (typeof chunk.confidence === "number") output.confidence = chunk.confidence;
  return output;
}

const EXCERPT_CONTEXT_CHARS = 80;

/**
 * 摘录：在转写全文中定位 token 首次出现位置，取前后各 ~80 字符（中文场景友好）。
 * 分词时 ASCII 被小写化，因此定位用大小写不敏感匹配；转写中未命中时回退标题，仍无则取开头。
 */
export function buildExcerpt(transcriptJson: string, token: string, fallbackTitle: string): string {
  const haystack = transcriptText(transcriptJson);
  const needle = token.toLowerCase();
  let source = haystack;
  let index = haystack.toLowerCase().indexOf(needle);
  if (index === -1) {
    source = fallbackTitle;
    index = fallbackTitle.toLowerCase().indexOf(needle);
  }
  if (index === -1) {
    return source.length > 0 ? source.slice(0, EXCERPT_CONTEXT_CHARS * 2) : "";
  }
  const start = Math.max(0, index - EXCERPT_CONTEXT_CHARS);
  const end = Math.min(source.length, index + needle.length + EXCERPT_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  return `${prefix}${source.slice(start, end)}${suffix}`;
}
