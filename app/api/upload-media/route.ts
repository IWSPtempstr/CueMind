// Local media upload endpoint: accepts a raw media file via multipart/form-data,
// converts it to a 16 kHz mono WAV with ffmpeg, runs local whisper.cpp ASR on it,
// and returns timestamped transcript chunks keyed by the caller-provided uploadId.
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
//
// The testable implementation lives in lib/upload-media.ts because Route Handlers may only
// export HTTP methods and framework config fields.

import { NextResponse } from "next/server";
import { assertUploadSize, handleUploadMedia } from "@/lib/upload-media";
import type {
  UploadMediaErrorPayload,
  UploadMediaSuccessPayload,
} from "@/lib/upload-media";

export const runtime = "nodejs";

export async function POST(
  request: Request,
): Promise<NextResponse<UploadMediaSuccessPayload | UploadMediaErrorPayload>> {
  // Reject oversized uploads BEFORE consuming/streaming the multipart body.
  const oversizeByHeaders = assertUploadSize(request.headers);
  if (oversizeByHeaders) return oversizeByHeaders;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  return handleUploadMedia(formData);
}
