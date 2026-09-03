import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, readJsonBodyWithLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { getKnowledgeMemoryStore } from "@/lib/knowledge-memory-store";
import type { MemoryKind } from "@/lib/knowledge-memory";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 500;
// Security plan §6.1: the query-only payload is tiny; reject oversized bodies
// before parsing (413), never truncate.
const LOCAL_MEMORY_BODY_MAX_BYTES = 16 * 1024;

function parseKind(value: unknown): MemoryKind | undefined {
  return value === "knowledge_card" || value === "meeting_decision" ? value : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "local-memory", 60);
  if (limited) return limited;
  const parsedBody = await readJsonBodyWithLimit(request, LOCAL_MEMORY_BODY_MAX_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body: unknown = parsedBody.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim().length === 0) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  const query = record.query.trim().slice(0, MAX_QUERY_CHARS);
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? Math.min(Math.max(Math.round(record.limit), 1), 20) : 3;
  const kind = parseKind(record.kind);
  try {
    const results = getKnowledgeMemoryStore().search({ query, kind, limit, at: typeof record.at === "string" ? record.at : undefined });
    return NextResponse.json({ query, results });
  } catch {
    return NextResponse.json({ error: "Local memory index unavailable", results: [] }, { status: 503 });
  }
}
