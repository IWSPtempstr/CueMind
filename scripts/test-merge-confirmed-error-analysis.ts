import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(process.cwd());
const out = "/tmp/cuemind-confirmed-error-analysis-test";
execFileSync("rm", ["-rf", out]);
execFileSync("npx", ["tsx", "scripts/merge-confirmed-error-analysis.ts", "--annotations-dir", "reports/finetune/annotations-v2/error-analysis", "--transcript-dir", "reports/video-reimport-20260830-cuda-zh/transcripts", "--out", out], { cwd: root, env: { ...process.env, TMPDIR: "/tmp" }, stdio: "inherit" });
const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
assert.equal(manifest.humanConfirmed, true);
assert.equal(manifest.freezeExcluded, 0);
assert.equal(manifest.counts.trigger, 59);
assert.equal(manifest.counts.keyword, 27);
assert.equal(manifest.counts.explanation, 40);
assert.equal(manifest.counts.dpo, 40);
console.log("confirmed error-analysis merge tests passed");
