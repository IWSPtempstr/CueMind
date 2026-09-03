// Server-side session snapshot persistence (M1 groundwork for the knowledge-export MCP).
// POST { snapshot }        → idempotent upsert by id → { saved: true }
// GET ?id=…                → { session: StoredSession } (complete, incl. transcriptJson)
// GET ?q=…                 → { results: [{ session: SessionSummary, score }] } (FTS5 bigram)
// GET ?from=&to=&limit=    → { sessions: SessionSummary[] } (updatedAt desc, no transcriptJson)
// GET is read-only (MCP dev self-test & future features). List/search never return
// the full transcriptJson payload to keep responses small.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import {
  getSession,
  searchSessions,
  toPublicSession,
  upsertSession,
  type StoredSession,
} from "@/lib/session-store";
import { requireSessionAccess } from "@/lib/session-route";
import { readSessionAccessToken } from "@/lib/session-auth";

export const runtime = "nodejs";

type SessionSummary = { id: string; title: string; createdAt: string; updatedAt: string; durationMs: number | null; inputSource: string | null; transcriptChars: number };

function toSummary(session: StoredSession): SessionSummary {
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, durationMs: session.durationMs, inputSource: session.inputSource, transcriptChars: session.transcriptJson.length };
}

export async function GET(
  request: NextRequest,
): Promise<
  NextResponse<
    { session: Omit<StoredSession, "sessionAccessTokenHash"> } | { results: Array<{ session: SessionSummary; score: number }> } | { sessions: SessionSummary[] } | { error: string }
  >
> {
  const params = request.nextUrl.searchParams;

  const id = params.get("id")?.trim() ?? "";
  if (id.length > 0) {
    const accessDenied = requireSessionAccess(request, id);
    if (accessDenied) return accessDenied;
    const session = getSession(id);
    if (session === null) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session: toPublicSession(session) });
  }

  const scopedSessionId = params.get("sessionId")?.trim() || request.headers.get("x-session-id")?.trim() || "";
  const accessDenied = requireSessionAccess(request, scopedSessionId);
  if (accessDenied) return accessDenied;
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 20) || 20, 1), 100);
  if (params.has("q")) {
    const query = params.get("q")?.trim() ?? "";
    const hit = searchSessions(query).find(({ session }) => session.id === scopedSessionId);
    return NextResponse.json({ results: hit ? [{ session: toSummary(hit.session), score: hit.score }] : [] });
  }
  const session = getSession(scopedSessionId);
  if (!session) return NextResponse.json({ sessions: [] });
  return NextResponse.json({ sessions: [toSummary(session)].slice(0, limit) });
}

export async function POST(
  request: NextRequest,
 ): Promise<NextResponse<{ saved: true; sessionAccessToken?: string } | { error: string }>> {
  const limited = enforceRateLimit(request, "sessions", 30);
  if (limited !== null) return limited;

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
  const sessionId = typeof record.id === "string" ? record.id.trim() : "";
  const existingSession = sessionId ? getSession(sessionId) : null;
  const accessDenied = existingSession
    ? requireSessionAccess(request, sessionId)
    : null;
  if (accessDenied) return accessDenied;

  let result;
  try {
    result = upsertSession(record, readSessionAccessToken(request.headers));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid session payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ saved: true, ...(result.sessionAccessToken ? { sessionAccessToken: result.sessionAccessToken } : {}) });
}
