import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordCandidate, decideRelease, rollbackRelease, readReleaseState } from "@/lib/model-release";

const root = mkdtempSync(path.join(tmpdir(), "cuemind-release-test-"));
recordCandidate(root, { version: "qwen-4b-q4-v2", modelHash: "abc", runtimeVersion: "llama.cpp-x", datasetVersion: "freeze-1", shadow: { requests: 10, errors: 0, p95Ms: 800 } });
assert.equal(decideRelease(root, "qwen-4b-q4-v2", "reviewer").status, "released");
assert.equal(readReleaseState(root).activeVersion, "qwen-4b-q4-v2");
assert.equal(rollbackRelease(root, "reviewer").status, "rolled_back");
assert.equal(readReleaseState(root).activeVersion, null);
assert.throws(() => decideRelease(root, "missing", "reviewer"));
assert.ok(readFileSync(path.join(root, ".cuemind-release.json"), "utf8").includes("reviewer"));
console.log("model release tests passed");
