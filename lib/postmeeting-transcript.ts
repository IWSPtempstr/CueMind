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

export async function createPostmeetingTranscript(
  chunks: Pick<TranscriptChunk, "text">[],
  options: { provider?: unknown; polish?: (text: string) => Promise<string> } = {},
): Promise<PostmeetingTranscriptArtifact> {
  const rawText = chunks.map((chunk) => chunk.text.trim()).filter(Boolean).join("\n");
  const rawHash = createHash("sha256").update(rawText, "utf8").digest("hex");
  const generatedAt = new Date().toISOString();
  if (!rawText) return { status: "fallback_raw", text: rawText, rawHash, provider: "injected", promptVersion: "postmeeting-polish-v1", generatedAt };
  try {
    const text = await (options.polish ? options.polish(rawText) : polishTranscript(rawText, options.provider));
    if (!text.trim()) throw new Error("empty polish output");
    return { status: "polished", text: text.trim(), rawHash, provider: options.polish ? "injected" : "local", promptVersion: "postmeeting-polish-v1", generatedAt };
  } catch (error) {
    return { status: "fallback_raw", text: rawText, rawHash, provider: options.polish ? "injected" : "local", promptVersion: "postmeeting-polish-v1", generatedAt, failureReason: error instanceof Error ? error.message : "polish failed" };
  }
}
