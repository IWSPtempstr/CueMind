import assert from "node:assert/strict";
import { getRealtimeAsrMode } from "@/lib/realtime-asr-config";

assert.equal(getRealtimeAsrMode({}), "streaming");
assert.equal(getRealtimeAsrMode({ CUEMIND_REALTIME_ASR: "streaming" }), "streaming");
assert.equal(getRealtimeAsrMode({ CUEMIND_REALTIME_ASR: "cli" }), "cli");
console.log("realtime asr config assertions passed");
