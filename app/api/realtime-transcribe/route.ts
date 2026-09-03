import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBodyWithLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { encodeSseEvent, LocalAgreement2 } from "@/lib/realtime-agreement";

const MAX_SNAPSHOTS = 240;
const MAX_SNAPSHOT_TEXT_CHARS = 12_000;
// Security plan §6.5: 240 snapshots × 12k chars ≈ 2.9MB upper bound; 4MB
// rejects oversized bodies with 413 before parsing.
const REALTIME_TRANSCRIBE_BODY_MAX_BYTES = 4 * 1024 * 1024;

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, "realtime-transcribe", 30);
  if (limited) return limited;
  const parsedBody = await readJsonBodyWithLimit(request, REALTIME_TRANSCRIBE_BODY_MAX_BYTES);
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  const body = parsedBody.body;
  if (!isRecord(body) || typeof body.runId !== "string" || !body.runId.trim() || body.runId.length > 160 || !Array.isArray(body.snapshots)) return NextResponse.json({ error: "runId and snapshots are required" }, { status: 400 });
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  if (body.snapshots.length > MAX_SNAPSHOTS) return NextResponse.json({ error: "Too many snapshots" }, { status: 413 });
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
function isSnapshot(value: unknown): value is { text: string; startMs: number; endMs: number } { return isRecord(value) && typeof value.text === "string" && value.text.length <= MAX_SNAPSHOT_TEXT_CHARS && value.text.trim().length > 0 && typeof value.startMs === "number" && typeof value.endMs === "number" && Number.isFinite(value.startMs) && Number.isFinite(value.endMs) && value.startMs >= 0 && value.endMs >= value.startMs; }
