// Local media upload endpoint: accepts a raw media file via multipart/form-data,
// converts it to a 16 kHz mono WAV with ffmpeg, runs local whisper.cpp ASR on it,
// and returns timestamped transcript chunks keyed by the caller-provided uploadId.
//
// Response modes:
// - Legacy (default): a single JSON payload once the WHOLE file is transcribed.
//   Kept for backward compatibility with existing clients and regression tests.
// - Streaming: when the multipart body carries `stream=1`, the handler answers
//   with Server-Sent Events (`data: <JSON>\n\n` frames): one event per finished
//   60-second transcription window, then one terminal done event, or — on any
//   failure — exactly one terminal error event and stream close.
//
// Large-body / streaming semantics:
// - Next.js App Router route handlers impose no built-in body size limit (unlike the old
//   Pages Router `bodyParser.sizeLimit`), so no extra Next config is needed here; instead
//   this handler enforces the 2048MB cap itself.
// - Before the multipart stream is consumed, the client-declared Content-Length header is
//   compared against MAX_UPLOAD_BYTES so an over-limit request can be rejected with 413
//   without ever buffering gigabytes of payload in memory or on disk.
// - After formData() parsing, the parsed File.size is validated again as the authoritative
//   byte count (streaming clients may omit or lie about Content-Length). The accepted bytes
//   are written once into a private temp directory which is always removed in a finally block.
// - A client disconnect aborts request.signal; the streaming branch then stops scheduling
//   further whisper windows, runs the generator's cleanup, and closes silently.
//
// The testable implementation lives in lib/upload-media.ts because Route Handlers may only
// export HTTP methods and framework config fields.

import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import {
  assertUploadSize,
  handleUploadMedia,
  processUploadStreaming,
} from "@/lib/upload-media";
import type {
  StreamDoneEvent,
  StreamErrorEvent,
  WindowResultEvent,
} from "@/lib/upload-media";

export const runtime = "nodejs";

type StreamPayload = WindowResultEvent | StreamDoneEvent | StreamErrorEvent;

function toErrorEvent(caught: unknown): StreamErrorEvent {
  const code =
    typeof (caught as { code?: unknown } | null)?.code === "string"
      ? (caught as { code: string }).code
      : undefined;
  const message =
    caught instanceof Error && caught.message.trim()
      ? caught.message
      : "Local ASR failed while processing the uploaded media";
  return code ? { type: "error", message, code } : { type: "error", message };
}

async function pumpStreamingResponse(
  formData: FormData,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
      };
      signal.addEventListener("abort", onAbort);

      const send = (event: StreamPayload): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const iterator = processUploadStreaming(formData, { signal });
      try {
        while (!aborted && !signal.aborted) {
          const next = await iterator.next();
          if (aborted || signal.aborted || next.done) break;
          send(next.value);
        }
      } catch (caught) {
        // Client disconnect → stay silent; otherwise emit one terminal error event (never followed by done).
        if (!aborted && !signal.aborted) {
          try {
            send(toErrorEvent(caught));
          } catch {
            // Controller already gone; nothing else to report.
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (aborted || signal.aborted) {
          // Triggers the generator's finally block to clean up temp/window files.
          await iterator.return(undefined).catch(() => undefined);
        }
        try {
          controller.close();
        } catch {
          // Already closed by the runtime after client disconnect.
        }
      }
    },
  });
}

export async function POST(
  request: Request,
): Promise<Response> {
  const limited = enforceRateLimit(request, "upload-media", 12);
  if (limited) return limited;
  const sessionId = request.headers.get("x-session-id")?.trim() ?? "";
  const accessDenied = requireSessionAccess(request, sessionId);
  if (accessDenied) return accessDenied;
  // Reject oversized uploads BEFORE consuming/streaming the multipart body.
  const oversizeByHeaders = assertUploadSize(request.headers);
  if (oversizeByHeaders) return oversizeByHeaders;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  // HTTP callers cannot choose executables or model files. Testable lower-level helpers
  // may still inject paths, but route input is stripped before processing.
  formData.delete("whisperPath");
  formData.delete("whisperModelPath");
  formData.delete("ffmpegPath");
  formData.delete("vadModelPath");

  if (formData.get("stream") === "1") {
    return new Response(await pumpStreamingResponse(formData, request.signal), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return handleUploadMedia(formData);
}
