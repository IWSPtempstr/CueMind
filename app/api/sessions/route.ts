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
  listSessions,
  searchSessions,
  upsertSession,
  type StoredSession,
} from "@/lib/session-store";

export const runtime = "nodejs";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

type SessionSummary = Omit<StoredSession, "transcriptJson" | "cardsJson" | "metricsJson"> & {
  transcriptChars: number;
};

function toSummary(session: StoredSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    durationMs: session.durationMs,
    inputSource: session.inputSource,
    transcriptChars: session.transcriptJson.length,
  };
}

export async function GET(
  request: NextRequest,
): Promise<
  NextResponse<
    { session: StoredSession } | { results: Array<{ session: SessionSummary; score: number }> } | { sessions: SessionSummary[] } | { error: string }
  >
> {
  const params = request.nextUrl.searchParams;

  const id = params.get("id")?.trim() ?? "";
  if (id.length > 0) {
    const session = getSession(id);
    if (session === null) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  }

  const query = params.get("q")?.trim() ?? "";
  if (query.length > 0) {
    const results = searchSessions(query).map((hit) => ({
      session: toSummary(hit.session),
      score: hit.score,
    }));
    return NextResponse.json({ results });
  }

  const from = params.get("from")?.trim() || undefined;
  const to = params.get("to")?.trim() || undefined;
  let limit = DEFAULT_LIST_LIMIT;
  const limitParam = params.get("limit");
  if (limitParam !== null && limitParam.trim().length > 0) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_LIST_LIMIT);
  }

  return NextResponse.json({ sessions: listSessions({ from, to, limit }).map(toSummary) });
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ saved: true } | { error: string }>> {
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

  try {
    upsertSession(body as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid session payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  return NextResponse.json({ saved: true });
}
