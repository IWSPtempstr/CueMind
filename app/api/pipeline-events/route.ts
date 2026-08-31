import { NextResponse } from "next/server";
import { appendPipelineEvents, parsePipelineEvents } from "@/lib/pipeline-event-store";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse<{ accepted: number } | { error: string }>> {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const events = parsePipelineEvents(body);
  if (events === null) return NextResponse.json({ error: "Invalid pipeline event batch" }, { status: 400 });
  try { appendPipelineEvents(events); } catch { return NextResponse.json({ error: "Pipeline event persistence failed" }, { status: 503 }); }
  return NextResponse.json({ accepted: events.length });
}
