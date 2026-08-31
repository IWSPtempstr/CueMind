import assert from "node:assert/strict";
import { LocalAgreement2, encodeSseEvent, parseSseFrames } from "@/lib/realtime-agreement";

const agreement = new LocalAgreement2();
assert.equal(agreement.push({ text: "alpha beta", startMs: 0, endMs: 1000 }).confirmedText, "");
assert.equal(agreement.push({ text: "alpha better", startMs: 0, endMs: 1200 }).confirmedText, "alpha");
assert.equal(agreement.confirmedUntilMs, 1000);
assert.equal(agreement.push({ text: "alpha", startMs: 0, endMs: 900 }).confirmedText, "");
assert.equal(agreement.metrics().rollbackCount, 1);
const frame = encodeSseEvent({ type: "partial", runId: "r", segmentId: "s", text: "hi", startMs: 0, endMs: 10 });
assert.deepEqual(parseSseFrames(`${frame}\n${encodeSseEvent({ type: "final", runId: "r", segmentId: "s", text: "hi", startMs: 0, endMs: 10 })}`), [
  { type: "partial", runId: "r", segmentId: "s", text: "hi", startMs: 0, endMs: 10 },
  { type: "final", runId: "r", segmentId: "s", text: "hi", startMs: 0, endMs: 10 },
]);
console.log("realtime agreement assertions passed");
