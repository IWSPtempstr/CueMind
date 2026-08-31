import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { createPostmeetingTranscript } from "@/lib/postmeeting-transcript";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "postmeeting-transcript", 10);
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.transcriptChunks) || record.transcriptChunks.length === 0) return NextResponse.json({ error: "transcriptChunks is required" }, { status: 400 });
  const chunks = record.transcriptChunks.slice(0, 20_000).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const text = (raw as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? [{ text: text.slice(0, 20_000) }] : [];
  });
  if (chunks.length === 0) return NextResponse.json({ error: "transcriptChunks must contain text" }, { status: 400 });
  const artifact = await createPostmeetingTranscript(chunks, { provider: record.provider });
  return NextResponse.json(artifact);
}
