import assert from "node:assert/strict";
import {
  appendPipelineEvent,
  createPipelineEvent,
  createRequestTimeline,
  getStageDurations,
  redactEventMetadata,
  validateRequestTimeline,
} from "@/lib/request-timeline";

const event = createPipelineEvent("run-1", "capture_start", 10, {
  source: "microphone",
  transcript: "must not be persisted",
  apiKey: "secret",
});
assert.deepEqual(event, {
  runId: "run-1",
  name: "capture_start",
  atMs: 10,
  metadata: { source: "microphone" },
});
assert.deepEqual(redactEventMetadata({ source: "system", answer: "private" }), { source: "system" });

const valid = createRequestTimeline("run-1", [
  { name: "request_start", atMs: 0 },
  { name: "capture_start", atMs: 10 },
  { name: "capture_end", atMs: 20 },
  { name: "complete", atMs: 30 },
], "answered");
assert.deepEqual(getStageDurations(valid), {
  captureMs: 10,
  asrMs: null,
  keywordMs: null,
  renderMs: null,
});
assert.equal(validateRequestTimeline(valid).valid, true);

assert.throws(() => createRequestTimeline("run-1", [
  { name: "request_start", atMs: 10 },
  { name: "capture_start", atMs: 9 },
], "failed"), /order regressed/);
assert.throws(() => createRequestTimeline("run-1", [
  { name: "request_start", atMs: 0 },
  { name: "capture_start", atMs: 1 },
  { name: "capture_start", atMs: 2 },
], "failed"), /duplicate/);

// The sink must be best-effort and preserve the same redacted event contract.
assert.equal(typeof appendPipelineEvent, "function");
console.log("request timeline event tests passed");
