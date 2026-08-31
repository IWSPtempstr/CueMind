import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadTranscriptDirectory, type WindowSample } from "@/lib/finetune-dataset";

type Row = Record<string, unknown> & {
  _file?: string; windowId?: string; videoId?: string; split?: string;
  annotator?: string; reviewStatus?: string; annotationVersion?: string;
  correctTrigger?: string; reason?: string; correctKeyword?: string; aliases?: string[];
  poorExplanation?: unknown; input?: unknown; chosen?: unknown; rejected?: unknown; rejectionReason?: string[];
  annotationDate?: string; id?: string;
};
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const annotationDir = path.resolve(arg("--annotations-dir", "reports/finetune/annotations-v2/error-analysis"));
const transcriptDir = path.resolve(arg("--transcript-dir", "reports/video-reimport-20260830-cuda-zh/transcripts"));
const outDir = path.resolve(arg("--out", "reports/finetune/annotations-v2/confirmed-error-analysis"));
const read = (name: string): Row[] => readFileSync(path.join(annotationDir, name), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const samples = loadTranscriptDirectory(transcriptDir, "local-video-v2");
const byWindow = new Map<string, WindowSample>();
for (const sample of samples) byWindow.set(`${sample.sourceFile.replace(/\.json$/, "")}:${sample.startMs}-${sample.endMs}`, sample);
const files = ["missed-trigger.jsonl", "false-positive-trigger.jsonl", "keyword-drift.jsonl", "poor-explanation.jsonl", "dpo-preference-pairs.jsonl"];
const all: Row[] = files.flatMap((file) => read(file).map((row): Row => ({ ...row, _file: file })));
const seen = new Set<string>();
for (const row of all) {
  if (row.annotator !== "human" || row.reviewStatus !== "confirmed" || row.annotationVersion !== "v2") throw new Error(`Unconfirmed row: ${row.windowId ?? row.id}`);
  if (row.split !== "train" && row.split !== "eval") throw new Error(`Invalid split or freeze row: ${row.windowId ?? row.id}`);
  const windowId = row.windowId;
  if (!windowId || seen.has(`${row._file}:${windowId}`)) throw new Error(`Duplicate or missing windowId: ${windowId}`);
  seen.add(`${row._file}:${windowId}`);
  const sample = byWindow.get(windowId);
  if (!sample) throw new Error(`Unknown annotation window: ${windowId}`);
  if (sample.sourceFile.replace(/\.json$/, "") !== row.videoId) throw new Error(`videoId mismatch: ${windowId}`);
}
const sampleRecord = (row: Row) => { if (!row.windowId) throw new Error("Missing windowId"); const s = byWindow.get(row.windowId); if (!s) throw new Error(`Unknown annotation window: ${row.windowId}`); return { id: s.id, windowId: row.windowId, videoId: row.videoId, split: row.split, input: s.text, sourceFile: s.sourceFile, humanConfirmed: true, confirmationDate: row.annotationDate, annotation: row }; };
const triggerRows = all.filter((r) => r._file === "missed-trigger.jsonl" || r._file === "false-positive-trigger.jsonl").map((r) => ({ ...sampleRecord(r), output: { trigger: r.correctTrigger === "show", reason: r.reason } }));
const keywordRows = all.filter((r) => r._file === "keyword-drift.jsonl" && typeof r.correctKeyword === "string").map((r) => ({ ...sampleRecord(r), output: { keyword: r.correctKeyword, aliases: r.aliases ?? [] } }));
const explanationRows = all.filter((r) => r._file === "poor-explanation.jsonl").map((r) => ({ ...sampleRecord(r), output: r.poorExplanation }));
const dpoRows = all.filter((r) => r._file === "dpo-preference-pairs.jsonl").map((r) => ({ ...sampleRecord(r), input: r.input, chosen: r.chosen, rejected: r.rejected, rejectionReason: r.rejectionReason }));
mkdirSync(outDir, { recursive: true });
const write = (name: string, rows: Row[]) => writeFileSync(path.join(outDir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
write("trigger-sft.jsonl", triggerRows); write("keyword-sft.jsonl", keywordRows); write("explanation-sft.jsonl", explanationRows); write("explanation-dpo.jsonl", dpoRows);
write("audit.jsonl", all.map((r) => ({ file: r._file, windowId: r.windowId, videoId: r.videoId, split: r.split, humanConfirmed: true })));
const manifest = { generatedAt: new Date().toISOString(), humanConfirmed: true, sourceFiles: files, transcriptDir, datasetVersion: "local-video-v2", freezeExcluded: all.filter((r) => r.split === "freeze").length, counts: { trigger: triggerRows.length, keyword: keywordRows.length, explanation: explanationRows.length, dpo: dpoRows.length }, splits: Object.fromEntries(["train", "eval"].map((split) => [split, all.filter((r) => r.split === split).length])) };
writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
