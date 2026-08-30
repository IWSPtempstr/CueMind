import assert from "node:assert/strict";
import { assertExtendedDatasetSize, parseAskEvaluationManifest, summarizeAskResults, type AskEvaluationResult } from "@/scripts/evaluate-ask-extended";

function testManifestRequiresAuthorizedQuestions(): void {
  assert.throws(
    () => parseAskEvaluationManifest(JSON.stringify({ version: "v1", authorized: false, questions: [] })),
    /authorized/i,
  );
  assert.throws(
    () => parseAskEvaluationManifest(JSON.stringify({ version: "v1", authorized: true, questions: [{ question: "" }] })),
    /question/i,
  );
}

function testManifestSeparatesCacheModes(): void {
  const manifest = parseAskEvaluationManifest(JSON.stringify({
    version: "v1",
    authorized: true,
    questions: [
      { id: "cold-1", question: "What is KV cache?", cacheMode: "cold" },
      { id: "hot-1", question: "What is LoRA?", cacheMode: "hot" },
    ],
  }));
  assert.deepEqual(manifest.questions.map((item) => item.cacheMode), ["cold", "hot"]);
  assert.throws(() => assertExtendedDatasetSize(manifest), /at least 30/);
}

function testSummaryKeepsFailuresInDenominator(): void {
  const results: AskEvaluationResult[] = [
    { id: "a", cacheMode: "cold", question: "a", status: "answered", completionMs: 100, firstEventMs: 20, firstByteMs: 90, finalState: "answered", stages: null, error: null },
    { id: "b", cacheMode: "cold", question: "b", status: "failed", completionMs: 200, firstEventMs: null, firstByteMs: null, finalState: "model_failed", stages: null, error: "timeout" },
  ];
  const summary = summarizeAskResults(results);
  assert.equal(summary.denominator.total, 2);
  assert.equal(summary.denominator.failed, 1);
  assert.equal(summary.byCacheMode.cold.denominator.total, 2);
  assert.equal(summary.byCacheMode.cold.denominator.failed, 1);
  assert.ok(summary.byCacheMode.cold.completionMs);
  assert.equal(summary.byCacheMode.cold.completionMs.p50, 100);
}

testManifestRequiresAuthorizedQuestions();
testManifestSeparatesCacheModes();
testSummaryKeepsFailuresInDenominator();
console.log("extended ask evaluator contract tests passed");
