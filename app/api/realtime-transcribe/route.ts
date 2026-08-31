import { NextResponse } from "next/server";
import { encodeSseEvent, LocalAgreement2 } from "@/lib/realtime-agreement";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!isRecord(body) || typeof body.runId !== "string" || !body.runId.trim() || !Array.isArray(body.snapshots)) return NextResponse.json({ error: "runId and snapshots are required" }, { status: 400 });
  const runId = body.runId.trim();
  const snapshots = body.snapshots.filter(isSnapshot);
  const stream = new ReadableStream({
    async start(controller) {
      const agreement = new LocalAgreement2();
      try {
        for (let index = 0; index < snapshots.length; index += 1) {
          if (request.signal.aborted) break;
          const snapshot = snapshots[index];
          const partial = encodeSseEvent({ runId, segmentId: `segment-${index}`, type: "partial", text: snapshot.text, startMs: snapshot.startMs, endMs: snapshot.endMs });
          controller.enqueue(new TextEncoder().encode(partial));
          const result = agreement.push(snapshot);
          if (result.confirmedText) controller.enqueue(new TextEncoder().encode(encodeSseEvent({ runId, segmentId: `segment-${index}`, type: "confirmed", text: result.confirmedText, startMs: snapshot.startMs, endMs: agreement.confirmedUntilMs })));
        }
        if (!request.signal.aborted) controller.enqueue(new TextEncoder().encode(encodeSseEvent({ runId, segmentId: "final", type: "final", text: snapshots.at(-1)?.text ?? "final", startMs: snapshots.at(-1)?.startMs ?? 0, endMs: snapshots.at(-1)?.endMs ?? 0 })));
        controller.close();
      } catch (error) { controller.error(error); }
    },
    cancel() { return undefined; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSnapshot(value: unknown): value is { text: string; startMs: number; endMs: number } { return isRecord(value) && typeof value.text === "string" && value.text.trim().length > 0 && typeof value.startMs === "number" && typeof value.endMs === "number" && value.startMs >= 0 && value.endMs >= value.startMs; }
