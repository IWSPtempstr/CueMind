import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { appendPipelineEvents, parsePipelineEvents } from "@/lib/pipeline-event-store";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse<{ accepted: number } | { error: string }>> {
  const limited = enforceRateLimit(request, "pipeline-events", 120);
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const sessionId = request.headers.get("x-session-id")?.trim() ?? "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  const events = parsePipelineEvents(body);
  if (events === null) return NextResponse.json({ error: "Invalid pipeline event batch" }, { status: 400 });
  try { appendPipelineEvents(events); } catch { return NextResponse.json({ error: "Pipeline event persistence failed" }, { status: 503 }); }
  return NextResponse.json({ accepted: events.length });
}
