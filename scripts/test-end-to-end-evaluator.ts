import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const oldFormatCases = [
  { id: "generated", actualDecision: "generate_card", cardSuccess: true, gracefulFailure: false },
  { id: "skipped", actualDecision: "skip", cardSuccess: false, gracefulFailure: true },
  { id: "schema-failed", actualDecision: "schema_failed", cardSuccess: false, gracefulFailure: true },
  { id: "unknown", actualDecision: "future_state", cardSuccess: false, gracefulFailure: false },
];

async function main(): Promise<void> {
  const root = process.cwd();
  const tempRoot = await mkdtemp(join(tmpdir(), "cuemind-e2e-evaluator-"));
  const contextReportDir = join(tempRoot, "context-report");
  const outputDir = join(tempRoot, "output");
  const liveFailureCases = join(tempRoot, "live-failure.jsonl");
  const liveReplayReportDir = join(tempRoot, "live-replay-report");
  await mkdir(contextReportDir, { recursive: true });
  await writeFile(liveFailureCases, `${JSON.stringify({
    requestMetadata: { mode: "live" },
    card: null,
    failure: { reason: "llama.cpp provider unreachable" },
    trace: { finalState: "model_failed", events: [], totalLatencyMs: 3 },
  })}\n`, "utf8");
  await mkdir(liveReplayReportDir, { recursive: true });
  await writeFile(join(liveReplayReportDir, "scorecard.json"), JSON.stringify({ status: "pass" }), "utf8");
  await writeFile(
    join(contextReportDir, "cases.jsonl"),
    oldFormatCases.map((value) => JSON.stringify(value)).join("\n") + "\n",
    "utf8",
  );

  try {
    await execFileAsync(process.execPath, [
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      resolve(root, "scripts/evaluate-end-to-end.ts"),
    ], {
      cwd: root,
      env: {
        ...process.env,
        E2E_OUTPUT_DIR: outputDir,
        CONTEXT_CARD_REPORT_DIR: contextReportDir,
        PROVIDER_REPORT_DIR: join(tempRoot, "provider-report"),
        REPLAY_REPORT_DIR: join(tempRoot, "replay-report"),
        REPLAY_INPUT_JSONL: join(tempRoot, "missing-replay.jsonl"),
      },
    });

    const scorecard = JSON.parse(await readFile(join(outputDir, "scorecard.json"), "utf8")) as {
      cardCount: number;
      terminalStateCounts: Record<string, number>;
    };
    assert.equal(scorecard.cardCount, 1);
    assert.deepEqual(scorecard.terminalStateCounts, {
      card_shown: 1,
      model_skip: 1,
      invalid_schema: 1,
      future_state: 1,
    });
    assert.equal(scorecard.terminalStateCounts.future_state, 1);
    const blockedExternalDependencies = (scorecard as typeof scorecard & {
      blockedExternalDependencies: string[];
    }).blockedExternalDependencies;
    assert.ok(blockedExternalDependencies.includes("live_search_unavailable"));
    assert.ok(blockedExternalDependencies.includes("live_context_card_runtime_unverified"));
    assert.ok(!blockedExternalDependencies.includes("live_search_or_context_card_runtime"));
    assert.equal((scorecard as typeof scorecard & { searchEvidence: string }).searchEvidence, "fixed_snapshot_only");

    const liveOutputDir = join(tempRoot, "live-output");
    await execFileAsync(process.execPath, [
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      resolve(root, "scripts/evaluate-end-to-end.ts"),
    ], {
      cwd: root,
      env: {
        ...process.env,
        E2E_OUTPUT_DIR: liveOutputDir,
        CONTEXT_CARD_REPORT_DIR: contextReportDir,
        PROVIDER_REPORT_DIR: join(tempRoot, "provider-report"),
        REPLAY_REPORT_DIR: liveReplayReportDir,
        REPLAY_INPUT_JSONL: liveFailureCases,
      },
    });
    const liveScorecard = JSON.parse(await readFile(join(liveOutputDir, "scorecard.json"), "utf8")) as {
      status: string;
      releaseGate: string;
      blockedExternalDependencies: string[];
    };
    assert.notEqual(liveScorecard.status, "complete");
    assert.notEqual(liveScorecard.releaseGate, "pass");
    assert.ok(liveScorecard.blockedExternalDependencies.includes("local_model_runtime_unavailable"));
    assert.ok(liveScorecard.blockedExternalDependencies.includes("live_search_unavailable"));
    assert.ok(liveScorecard.blockedExternalDependencies.includes("live_context_card_runtime_unverified"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log("end-to-end evaluator tests passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
