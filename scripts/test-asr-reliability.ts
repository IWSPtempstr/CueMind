import assert from "node:assert/strict";
import { assertConfirmedProgress, summarizeAsrRuns, type ConfirmedSnapshot } from "@/lib/asr-reliability";

const good: ConfirmedSnapshot[] = [
  { atMs: 0, text: "今天讨论" },
  { atMs: 1000, text: "今天讨论 KV cache" },
];
assert.doesNotThrow(() => assertConfirmedProgress(good));
assert.throws(() => assertConfirmedProgress([{ atMs: 0, text: "abc" }, { atMs: 1, text: "ab" }]));
assert.throws(() => assertConfirmedProgress([{ atMs: 0, text: "abc" }, { atMs: 1, text: "abc" }]));
const metrics = summarizeAsrRuns([{ audioMs: 1000, elapsedMs: 500 }, { audioMs: 2000, elapsedMs: 1000 }]);
assert.equal(metrics.throughputAudioSecondsPerSecond, 2);
assert.equal(metrics.runCount, 2);
console.log("asr reliability tests passed");
