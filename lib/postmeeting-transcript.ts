import { createHash } from "node:crypto";
import type { TranscriptChunk } from "@/types/session";
import { polishTranscript } from "@/lib/transcript-polish";

export interface PostmeetingTranscriptArtifact {
  status: "polished" | "fallback_raw";
  text: string;
  rawHash: string;
  provider: "local" | "injected";
  promptVersion: string;
  generatedAt: string;
  failureReason?: string;
}

/**
 * Per-chunk character budget for polishing. The local llama.cpp model has an
 * 8k context window and Chinese text runs ~0.6-1 token/char, so a single shot
 * can only carry a few thousand chars in plus its output. Oversized
 * transcripts are split on this budget so the report still gets polished
 * without blowing the context window.
 */
const POLISH_CHUNK_CHARS = 4_000;

/** Splits raw transcript text into ≤ POLISH_CHUNK_CHARS chunks at chunk boundaries. */
function splitIntoChunks(rawText: string): string[] {
  if (rawText.length <= POLISH_CHUNK_CHARS) return [rawText];
  const chunks: string[] = [];
  let remaining = rawText;
  while (remaining.length > POLISH_CHUNK_CHARS) {
    // Prefer breaking at a newline near the budget; fall back to a hard slice.
    const window = remaining.slice(0, POLISH_CHUNK_CHARS);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > POLISH_CHUNK_CHARS * 0.5 ? lastNewline + 1 : POLISH_CHUNK_CHARS;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function createPostmeetingTranscript(
  chunks: Pick<TranscriptChunk, "text">[],
  options: { provider?: unknown; polish?: (text: string) => Promise<string> } = {},
): Promise<PostmeetingTranscriptArtifact> {
  const rawText = chunks.map((chunk) => chunk.text.trim()).filter(Boolean).join("\n");
  const rawHash = createHash("sha256").update(rawText, "utf8").digest("hex");
  const generatedAt = new Date().toISOString();
  if (!rawText) return { status: "fallback_raw", text: rawText, rawHash, provider: "injected", promptVersion: "postmeeting-polish-v1", generatedAt };
  try {
    // Long transcripts are polished chunk-by-chunk (keeps input+output within
    // the model's context window) and reassembled; a failing chunk falls back
    // to its raw slice so the flow is never blocked.
    const polished = await polishChunks(rawText, options);
    if (!polished.trim()) throw new Error("empty polish output");
    return { status: "polished", text: polished.trim(), rawHash, provider: options.polish ? "injected" : "local", promptVersion: "postmeeting-polish-v1", generatedAt };
  } catch (error) {
    return { status: "fallback_raw", text: rawText, rawHash, provider: options.polish ? "injected" : "local", promptVersion: "postmeeting-polish-v1", generatedAt, failureReason: error instanceof Error ? error.message : "polish failed" };
  }
}

async function polishChunks(
  rawText: string,
  options: { provider?: unknown; polish?: (text: string) => Promise<string> },
): Promise<string> {
  const parts = splitIntoChunks(rawText);
  if (parts.length === 1) {
    return options.polish ? options.polish(rawText) : polishTranscript(rawText, options.provider);
  }
  const output: string[] = [];
  for (const part of parts) {
    const polished = options.polish ? await options.polish(part) : await polishTranscript(part, options.provider);
    output.push(polished.trim() ? polished : part);
  }
  return output.join("\n");
}
