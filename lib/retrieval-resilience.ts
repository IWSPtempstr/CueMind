import type { AskCacheOrigin } from "@/lib/ask-cache";

export type CacheObservationClassification =
  | "cold_miss"
  | "card_warmed_hit"
  | "ask_hot_hit"
  | "expired_miss";

export interface CacheObservation {
  /** Whether this is the first lookup before any pipeline has warmed the cache. */
  before: boolean;
  /** The pipeline that warmed the cache, when there was a hit. */
  warmedBy: AskCacheOrigin | null;
  hit: boolean;
}

export function classifyCacheObservation(
  observation: CacheObservation,
): CacheObservationClassification {
  if (observation.hit) {
    if (observation.warmedBy === null) {
      throw new Error("cache hit requires warmedBy origin");
    }
    return observation.warmedBy === "context_card" ? "card_warmed_hit" : "ask_hot_hit";
  }
  return observation.before ? "cold_miss" : "expired_miss";
}
