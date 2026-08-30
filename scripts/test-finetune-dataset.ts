import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWindowSamples, normalizeDialogSumRow, writeDatasetBundle } from "@/lib/finetune-dataset";
import { buildTriggerPrompt, keywordConsistency, triggerMetrics } from "@/lib/finetune-experiments";

const root = mkdtempSync(path.join(tmpdir(), "cuemind-ft-data-"));
const transcript = path.join(root, "video.json");
writeFileSync(transcript, JSON.stringify({ transcription: [
  { offsets: { from: 0, to: 6000 }, text: "讨论 KV cache。" },
  { offsets: { from: 7000, to: 15000 }, text: "它可以减少重复计算。" },
] }), "utf8");
const samples = buildWindowSamples(transcript, { datasetVersion: "local-v1", windowMs: 30_000 });
assert.equal(samples.length, 1);
assert.equal(samples[0].source, "local-video");
assert.equal(samples[0].segments.length, 2);
assert.throws(() => normalizeDialogSumRow({ dialogue: "x" }), /summary/);
const row = normalizeDialogSumRow({ id: "d1", dialogue: "A: hello", summary: "Greeting", topic: "greeting" });
assert.equal(row.id, "d1");
assert.equal(row.text, "A: hello");
const out = writeDatasetBundle(root, { samples, dialogSum: [row], metadata: { source: "test" } });
assert.ok(readFileSync(out.manifest, "utf8").includes('"source": "test"'));
assert.equal(readFileSync(out.sft, "utf8").trim().split("\n").length, 1);
assert.match(buildTriggerPrompt({ id: "x", windowText: "讨论主题", label: "show", videoId: "v" }), /trigger/);
assert.equal(triggerMetrics([{ expected: true, actual: true }, { expected: false, actual: true }]).falsePositiveRate, 1);
assert.equal(keywordConsistency(["KV Cache", "kv cache"]), 1);
console.log("finetune dataset tests passed");
