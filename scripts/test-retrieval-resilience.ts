import assert from "node:assert/strict";
import { ASK_CACHE_TTL_MS, createAskCache } from "@/lib/ask-cache";
import { classifyCacheObservation } from "@/lib/retrieval-resilience";

let now = 1_000;
const cache = createAskCache(() => now);

cache.set("  KV Cache ", [], "ask");
assert.deepEqual(cache.get("kv cache")?.origin, "ask");
cache.set("card keyword", [], "context_card");
assert.deepEqual(cache.get("card keyword")?.origin, "context_card");
assert.equal(
  classifyCacheObservation({ before: true, warmedBy: null, hit: false }),
  "cold_miss",
);
assert.equal(
  classifyCacheObservation({ before: false, warmedBy: "context_card", hit: true }),
  "card_warmed_hit",
);
assert.equal(
  classifyCacheObservation({ before: false, warmedBy: "ask", hit: true }),
  "ask_hot_hit",
);
assert.throws(
  () => classifyCacheObservation({ before: false, warmedBy: null, hit: true }),
  /requires warmedBy origin/,
);

now += ASK_CACHE_TTL_MS;
assert.equal(cache.get("KV CACHE"), null);
assert.equal(
  classifyCacheObservation({ before: false, warmedBy: null, hit: false }),
  "expired_miss",
);

console.log("retrieval resilience contract red test passed");
