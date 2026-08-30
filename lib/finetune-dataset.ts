import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TranscriptSegment { startMs: number; endMs: number; text: string }
export interface WindowSample { id: string; source: "local-video"; sourceFile: string; startMs: number; endMs: number; text: string; segments: TranscriptSegment[]; datasetVersion: string }
export interface DialogSumSample { id: string; text: string; summary: string; topic: string | null; source: "dialogsum" }
export function buildWindowSamples(file: string, options: { datasetVersion: string; windowMs: number }): WindowSample[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> };
  const segments = (parsed.transcription ?? []).flatMap((item) => typeof item.text === "string" && typeof item.offsets?.from === "number" && typeof item.offsets?.to === "number" ? [{ startMs: item.offsets.from, endMs: item.offsets.to, text: item.text.trim() }] : []).filter((item) => item.text.length > 0);
  if (segments.length === 0) return [];
  const result: WindowSample[] = [];
  for (let start = segments[0].startMs; start <= segments[segments.length - 1].endMs; start += options.windowMs) {
    const end = start + options.windowMs; const selected = segments.filter((item) => item.startMs < end && item.endMs > start);
    if (selected.length === 0) continue;
    const id = createHash("sha256").update(`${options.datasetVersion}\0${path.basename(file)}\0${start}\0${end}`).digest("hex");
    result.push({ id, source: "local-video", sourceFile: path.basename(file), startMs: start, endMs: end, text: selected.map((item) => item.text).join(" "), segments: selected, datasetVersion: options.datasetVersion });
  }
  return result;
}
export function normalizeDialogSumRow(value: unknown): DialogSumSample {
  if (!value || typeof value !== "object") throw new Error("DialogSum row must be an object");
  const row = value as Record<string, unknown>; if (typeof row.dialogue !== "string" || !row.dialogue.trim() || typeof row.summary !== "string" || !row.summary.trim()) throw new Error("DialogSum row requires dialogue and summary");
  return { id: typeof row.id === "string" && row.id ? row.id : createHash("sha256").update(row.dialogue).digest("hex").slice(0, 16), text: row.dialogue.trim(), summary: row.summary.trim(), topic: typeof row.topic === "string" && row.topic.trim() ? row.topic.trim() : null, source: "dialogsum" };
}
export function writeDatasetBundle(outDir: string, args: { samples: WindowSample[]; dialogSum: DialogSumSample[]; metadata?: Record<string, unknown> }): { manifest: string; sft: string; dialogSum: string } {
  mkdirSync(outDir, { recursive: true }); const sft = path.join(outDir, "sft.jsonl"); const dialogSum = path.join(outDir, "dialogsum.jsonl"); const manifest = path.join(outDir, "manifest.json");
  writeFileSync(sft, args.samples.map((item) => JSON.stringify({ id: item.id, instruction: "判断该会议窗口是否应生成知识卡片，并输出 JSON。", input: item.text, source: item.source, sourceFile: item.sourceFile, label: null, split: "unlabeled" })).join("\n") + (args.samples.length ? "\n" : ""), "utf8");
  writeFileSync(dialogSum, args.dialogSum.map((item) => JSON.stringify(item)).join("\n") + (args.dialogSum.length ? "\n" : ""), "utf8");
  writeFileSync(manifest, `${JSON.stringify({ generatedAt: new Date().toISOString(), sampleCount: args.samples.length, dialogSumCount: args.dialogSum.length, ...args.metadata }, null, 2)}\n`, "utf8");
  return { manifest, sft, dialogSum };
}
export function loadTranscriptDirectory(dir: string, datasetVersion: string): WindowSample[] { return readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => buildWindowSamples(path.join(dir, file), { datasetVersion, windowMs: 30_000 })); }
