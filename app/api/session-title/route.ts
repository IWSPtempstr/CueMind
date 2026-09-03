// Extracts a meeting topic phrase via the local llama.cpp provider.
// Flow: validate JSON body → buildSessionTitle (local llama.cpp JSON chat) → { topic } or { error }.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { resolveLocalProvider } from "@/lib/llama-cpp";
import { enforceRateLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { buildSessionTitle } from "@/lib/session-title";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ topic: string } | { error: string }>> {
  const limited = enforceRateLimit(request, "session-title", 10);
  if (limited) return limited;
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;
  const transcript = typeof record.transcript === "string" ? record.transcript : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  if (transcript.trim().length === 0) {
    return NextResponse.json(
      { error: "transcript is required" },
      { status: 400 },
    );
  }

  try {
    const topic = await buildSessionTitle(transcript, resolveLocalProvider(record));
    return NextResponse.json({ topic });
  } catch (caught) {
    return NextResponse.json(
      {
        error: caught instanceof Error && caught.message
          ? caught.message
          : "Failed to generate the session topic",
      },
      { status: 502 },
    );
  }
}
