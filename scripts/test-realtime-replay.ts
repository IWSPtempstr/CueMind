import assert from "node:assert/strict";
import { createReplayController, createLocalTrace, summarizeReplay } from "@/lib/realtime-replay";

const controller = createReplayController(4);
assert.equal(controller.state, "paused");
assert.equal(controller.resume().state, "running");
assert.equal(controller.pause().state, "paused");
assert.equal(controller.resume().state, "running");
assert.equal(controller.next(), 1);
assert.equal(controller.next(), 2);
assert.equal(controller.seek(1).position, 1);
assert.equal(controller.restart().position, 0);
assert.equal(controller.cancel().state, "cancelled");
const trace = createLocalTrace("run-1", { stage: "asr", durationMs: 12, status: "ok" });
assert.equal(trace.runId, "run-1");
assert.equal(summarizeReplay([trace]).errorCount, 0);
console.log("realtime replay tests passed");
