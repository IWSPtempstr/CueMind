import type { AskCacheOrigin } from "@/lib/ask-cache";

export type CacheObservationClassification =
  | "cold_miss"
  | "card_warmed_hit"
  | "ask_hot_hit"
  | "expired_miss";

export interface CacheObservation {
  /** Whether the lookup was preceded by an already-warmed cache state. */
  before: boolean;
  /** The pipeline that warmed the cache, when there was a hit. */
  warmedBy: AskCacheOrigin | null;
  hit: boolean;
}

export function classifyCacheObservation(
  observation: CacheObservation,
): CacheObservationClassification {
  if (observation.hit) {
    return observation.warmedBy === "context_card" ? "card_warmed_hit" : "ask_hot_hit";
  }
  return observation.before ? "cold_miss" : "expired_miss";
}
