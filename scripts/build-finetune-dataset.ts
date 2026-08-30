import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadTranscriptDirectory, normalizeDialogSumRow, writeDatasetBundle, type DialogSumSample } from "@/lib/finetune-dataset";

function arg(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; }
const transcriptDir = path.resolve(arg("--transcript-dir", "reports/video-reimport-20260830-cuda-zh/transcripts"));
const outDir = path.resolve(arg("--out", "reports/finetune/local-v1"));
const datasetVersion = arg("--dataset-version", "local-video-v1");
const dialogSumPath = process.argv.includes("--dialogsum") ? path.resolve(arg("--dialogsum", "")) : null;
let dialogSum: DialogSumSample[] = [];
if (dialogSumPath) {
  const rows = readFileSync(dialogSumPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  dialogSum = rows.map(normalizeDialogSumRow);
}
const samples = loadTranscriptDirectory(transcriptDir, datasetVersion);
if (samples.length === 0) throw new Error(`No transcript JSON found in ${transcriptDir}`);
const result = writeDatasetBundle(outDir, { samples, dialogSum, metadata: { source: "local-video-transcripts", transcriptDir, publicDatasetDownload: "skipped-by-user", videoCount: new Set(samples.map((sample) => sample.sourceFile)).size, labelingRequired: true, splitPolicy: "by-video" } });
const fileCount = readdirSync(transcriptDir).filter((file) => file.endsWith(".json")).length;
console.log(JSON.stringify({ ...result, transcriptFiles: fileCount, windows: samples.length, dialogSum: dialogSum.length }, null, 2));
