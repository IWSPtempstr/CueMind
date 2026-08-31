import assert from "node:assert/strict";
import { buildRealtimeScorecard } from "@/lib/realtime-report";
const scorecard = buildRealtimeScorecard({ executedCases: 0, failures: ["real replay not executed"], confirmedDuplicates: 0, rollbackCount: 0 });
assert.equal(scorecard.releaseDecision, "keep-cli");
assert.equal(scorecard.gatesPassed, false);
console.log("realtime report assertions passed");
