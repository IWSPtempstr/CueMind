// Persists post-meeting follow-up chat messages server-side.
// GET  ?sessionId=… → { messages: StoredChatMessage[] } (createdAt ascending)
// POST { sessionId, messages } → idempotent upsert by id → { saved: n }

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  appendChatMessages,
  getChatMessages,
  type StoredChatMessage,
} from "@/lib/chat-store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
): Promise<NextResponse<{ messages: StoredChatMessage[] } | { error: string }>> {
  const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  if (sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  return NextResponse.json({ messages: getChatMessages(sessionId) });
}

function parseChatMessage(
  item: unknown,
): Omit<StoredChatMessage, "sessionId"> | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (record.role !== "user" && record.role !== "assistant") return null;
  if (typeof record.content !== "string") return null;
  if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return null;
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    isDetail: record.isDetail === true,
    createdAt: record.createdAt,
    sources: Array.isArray(record.sources) ? record.sources.filter((item): item is { title: string; url: string; sourceType?: string } => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).title === "string" && typeof (item as Record<string, unknown>).url === "string") : undefined,
    keywords: Array.isArray(record.keywords) ? record.keywords.filter((item): item is string => typeof item === "string") : undefined,
    finalState: typeof record.finalState === "string" ? record.finalState : undefined,
  };
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ saved: number } | { error: string }>> {
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
  if (sessionId.length === 0) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!Array.isArray(record.messages)) {
    return NextResponse.json({ error: "messages must be an array" }, { status: 400 });
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
