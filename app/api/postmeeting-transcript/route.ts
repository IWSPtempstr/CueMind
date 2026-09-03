import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBodyWithLimit } from "@/lib/api-security";
import { createPostmeetingTranscript } from "@/lib/postmeeting-transcript";
import { requireSessionAccess } from "@/lib/session-route";

export const runtime = "nodejs";

// Security plan §6.5: the effective transcript ceiling is 32k chars; 2MB of
// raw body is a generous envelope (chunks carry timestamps etc.) — reject
// anything larger with 413 before parsing.
const POSTMEETING_BODY_MAX_BYTES = 2 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "postmeeting-transcript", 10);
  if (limited) return limited;
  const parsedBody = await readJsonBodyWithLimit(request, POSTMEETING_BODY_MAX_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  const body: unknown = parsedBody.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const record = body as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  if (!Array.isArray(record.transcriptChunks) || record.transcriptChunks.length === 0) return NextResponse.json({ error: "transcriptChunks is required" }, { status: 400 });
  if (record.transcriptChunks.length > 2_000) return NextResponse.json({ error: "Too many transcript chunks" }, { status: 413 });
  const chunks = record.transcriptChunks.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const text = (raw as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? [{ text: text.slice(0, 20_000) }] : [];
  });
  if (chunks.length === 0) return NextResponse.json({ error: "transcriptChunks must contain text" }, { status: 400 });
  if (chunks.reduce((total, chunk) => total + chunk.text.length, 0) > 32_000) return NextResponse.json({ error: "Transcript is too large" }, { status: 413 });
  const artifact = await createPostmeetingTranscript(chunks, { provider: record.provider });
  return NextResponse.json(artifact);
}
