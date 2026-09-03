import { NextResponse } from "next/server";
import { readSessionAccessToken } from "@/lib/session-auth";
import { verifySessionAccess } from "@/lib/session-store";

export function unauthorizedSessionResponse(): NextResponse<{ error: string }> {
  return NextResponse.json({ error: "Session access denied" }, { status: 401 });
}

export function requireSessionAccess(request: Pick<Request, "headers">, sessionId: string | null | undefined): NextResponse<{ error: string }> | null {
  const normalizedSessionId = sessionId?.trim() ?? "";
  if (!normalizedSessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  const sessionAccessToken = readSessionAccessToken(request.headers);
  if (!sessionAccessToken) return unauthorizedSessionResponse();
  if (!verifySessionAccess(normalizedSessionId, sessionAccessToken)) return unauthorizedSessionResponse();
  return null;
}
