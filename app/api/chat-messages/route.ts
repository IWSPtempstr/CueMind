// Persists post-meeting follow-up chat messages server-side.
// GET  ?sessionId=… → { messages: StoredChatMessage[] } (createdAt ascending)
// POST { sessionId, messages } → idempotent upsert by id → { saved: n }

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import {
  appendChatMessages,
  getChatMessages,
  type StoredChatMessage,
} from "@/lib/chat-store";

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CONTENT_CHARS = 8_000;
const MAX_MESSAGE_SOURCES = 8;
const MAX_MESSAGE_KEYWORDS = 20;
const MAX_SOURCE_FIELD_CHARS = 1_000;
const MAX_KEYWORD_CHARS = 200;

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
): Promise<NextResponse<{ messages: StoredChatMessage[] } | { error: string }>> {
  const limited = enforceRateLimit(request, "chat-messages", 60);
  if (limited) return limited;
  const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  return NextResponse.json({ messages: getChatMessages(sessionId) });
}

function parseChatMessage(
  item: unknown,
): Omit<StoredChatMessage, "sessionId"> | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (record.role !== "user" && record.role !== "assistant") return null;
  if (typeof record.content !== "string" || record.content.length > MAX_MESSAGE_CONTENT_CHARS) return null;
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0 || record.createdAt.length > 80) return null;
  if (record.sources !== undefined && (!Array.isArray(record.sources) || record.sources.length > MAX_MESSAGE_SOURCES)) return null;
  if (record.keywords !== undefined && (!Array.isArray(record.keywords) || record.keywords.length > MAX_MESSAGE_KEYWORDS)) return null;
  let sources: StoredChatMessage["sources"];
  if (Array.isArray(record.sources)) {
    sources = [];
    for (const item of record.sources) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const source = item as Record<string, unknown>;
      if (typeof source.title !== "string" || typeof source.url !== "string" || source.title.length > MAX_SOURCE_FIELD_CHARS || source.url.length > MAX_SOURCE_FIELD_CHARS) return null;
      if (source.sourceType !== undefined && (typeof source.sourceType !== "string" || source.sourceType.length > 100)) return null;
      sources.push({ title: source.title, url: source.url, ...(typeof source.sourceType === "string" ? { sourceType: source.sourceType } : {}) });
    }
  }
  let keywords: string[] | undefined;
  if (Array.isArray(record.keywords)) {
    if (!record.keywords.every((item): item is string => typeof item === "string" && item.length <= MAX_KEYWORD_CHARS)) return null;
    keywords = record.keywords;
  }
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    isDetail: record.isDetail === true,
    createdAt: record.createdAt,
    sources,
    keywords,
    finalState: typeof record.finalState === "string" ? record.finalState : undefined,
  };
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ saved: number } | { error: string }>> {
  const limited = enforceRateLimit(request, "chat-messages", 60);
  if (limited) return limited;
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  if (!Array.isArray(record.messages)) {
    return NextResponse.json({ error: "messages must be an array" }, { status: 400 });
  }
  if (record.messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Too many messages" }, { status: 413 });
  }

  const messages: StoredChatMessage[] = [];
  for (const item of record.messages) {
    const parsed = parseChatMessage(item);
    if (parsed === null) {
      return NextResponse.json({ error: "Invalid chat message payload" }, { status: 400 });
    }
    messages.push({ ...parsed, sessionId });
  }

  appendChatMessages(messages);
  return NextResponse.json({ saved: messages.length });
}
