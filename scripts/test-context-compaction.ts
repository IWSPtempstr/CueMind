import assert from "node:assert/strict";
import { chooseCompressionTrigger } from "@/lib/realtime-context-memory";
assert.equal(chooseCompressionTrigger({ promptTokens: 7000, contextWindowTokens: 10000, askTurns: 1, meetingDurationMs: 0 }), "token_threshold");
assert.equal(chooseCompressionTrigger({ promptTokens: 1, contextWindowTokens: 10000, askTurns: 5, meetingDurationMs: 0 }), "ask_turn_count");
assert.equal(chooseCompressionTrigger({ promptTokens: 1, contextWindowTokens: 10000, askTurns: 1, meetingDurationMs: 600000 }), "meeting_duration");
assert.equal(chooseCompressionTrigger({ promptTokens: 1, contextWindowTokens: 10000, askTurns: 1, meetingDurationMs: 0, manual: true }), "manual");
console.log("context compaction assertions passed");
