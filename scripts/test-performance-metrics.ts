import assert from "node:assert/strict";
import {
  summarizeAsrMeasurements,
  validateSegmentTimeline,
  type AsrMeasurement,
} from "@/lib/performance-metrics";
import { extractLlamaTiming, summarizeLlamaTiming } from "@/lib/llama-timing";
import {
  createRequestTimeline,
  summarizeRequestTimeline,
  validateRequestTimeline,
} from "@/lib/request-timeline";

const asrRuns: AsrMeasurement[] = [
  { id: "a", audioDurationMs: 10_000, elapsedMs: 5_000, firstPartialMs: 1_200, confirmedMs: 2_000, status: "ok" },
  { id: "b", audioDurationMs: 20_000, elapsedMs: 10_000, firstPartialMs: 1_500, confirmedMs: 2_500, status: "ok" },
];
const asr = summarizeAsrMeasurements(asrRuns);
assert.equal(asr.audioSecondsPerSecond, 2);
assert.equal(asr.realTimeFactor, 0.5);
assert.equal(asr.firstPartialP50Ms, 1_200);
assert.equal(asr.confirmedP95Ms, 2_500);
assert.deepEqual(validateSegmentTimeline([
  { startMs: 0, endMs: 100, text: "a" },
  { startMs: 100, endMs: 200, text: "b" },
]), { ordered: true, overlaps: 0, duplicates: 0, empty: 0 });

const timing = extractLlamaTiming({
  timings: { prompt_n: 10, predicted_n: 20, prompt_ms: 100, predicted_ms: 400, predicted_per_second: 50 },
});
assert.deepEqual(timing, { promptTokens: 10, outputTokens: 20, promptMs: 100, generationMs: 400, tokensPerSecond: 50 });
assert.equal(summarizeLlamaTiming([timing]).tokensPerSecondP50, 50);

const timeline = createRequestTimeline("run-1", [
  { name: "request_start", atMs: 0 },
  { name: "first_event", atMs: 20 },
  { name: "complete", atMs: 100 },
], "answered");
assert.equal(validateRequestTimeline(timeline).valid, true);
assert.equal(summarizeRequestTimeline([timeline]).completionP95Ms, 100);
assert.throws(() => validateRequestTimeline({ ...timeline, events: [...timeline.events, { name: "first_token", atMs: -1 }] }));

console.log("performance metrics tests passed");
