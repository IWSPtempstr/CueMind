import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBodyWithLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { appendPipelineEvents, parsePipelineEvents } from "@/lib/pipeline-event-store";

export const runtime = "nodejs";

// Security plan §6.1/§6.4: bounded batch (≤32 events enforced by
// parsePipelineEvents) × bounded per-event size → 64KB ceiling is generous;
// oversized bodies are rejected with 413 before parsing.
const PIPELINE_EVENTS_BODY_MAX_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<NextResponse<{ accepted: number } | { error: string }>> {
  const limited = enforceRateLimit(request, "pipeline-events", 120);
  if (limited) return limited;
  const parsedBody = await readJsonBodyWithLimit(request, PIPELINE_EVENTS_BODY_MAX_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  const sessionId = request.headers.get("x-session-id")?.trim() ?? "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  const events = parsePipelineEvents(parsedBody.body);
  if (events === null) return NextResponse.json({ error: "Invalid pipeline event batch" }, { status: 400 });
  try { appendPipelineEvents(events); } catch { return NextResponse.json({ error: "Pipeline event persistence failed" }, { status: 503 }); }
  return NextResponse.json({ accepted: events.length });
}
