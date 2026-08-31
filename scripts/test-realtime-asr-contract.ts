import assert from "node:assert/strict";
import {
  RealtimeAsrState,
  createRealtimeAsrState,
  ingestRealtimeAsrEvent,
  parseRealtimeAsrEvent,
  type RealtimeAsrEvent,
} from "@/lib/realtime-asr-contract";

function event(overrides: Partial<RealtimeAsrEvent> = {}): RealtimeAsrEvent {
  return {
    runId: "run-1",
    segmentId: "segment-1",
    type: "partial",
    text: "hello",
    startMs: 0,
    endMs: 1000,
    ...overrides,
  };
}

assert.equal(parseRealtimeAsrEvent({ ...event(), text: "" }), null);
assert.throws(() => ingestRealtimeAsrEvent(createRealtimeAsrState("run-1"), event({ startMs: 900, endMs: 100 })), /timestamp/);
let state = createRealtimeAsrState("run-1");
state = ingestRealtimeAsrEvent(state, event({ type: "confirmed", text: "hello", endMs: 1000 }));
assert.equal(state.confirmedUntilMs, 1000);
assert.throws(() => ingestRealtimeAsrEvent(state, event({ type: "confirmed", text: "hello", endMs: 1000 })), /duplicate/);
assert.throws(() => ingestRealtimeAsrEvent(state, event({ type: "confirmed", segmentId: "segment-2", text: "old", endMs: 900 })), /watermark/);
assert.throws(() => ingestRealtimeAsrEvent(state, event({ runId: "run-2" })), /runId/);
assert.equal(ingestRealtimeAsrEvent(state, event({ type: "partial", text: "next", endMs: 1200 })).partialText, "next");
assert.equal(ingestRealtimeAsrEvent(state, event({ type: "final", text: "done", endMs: 1200 })).status, RealtimeAsrState.Finalized);
assert.equal(parseRealtimeAsrEvent({ ...event(), type: "unknown" }), null);
console.log("realtime asr contract assertions passed");
