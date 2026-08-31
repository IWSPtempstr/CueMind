// Term-level search-result cache for the live-ask pipeline (plan batch 1).
// Session-scoped in-memory Map with a 10-minute TTL so repeated asks on the
// same term (and the card pipeline's same-keyword searches) do not re-issue
// duplicate outbound requests. The singleton lives on globalThis so route
// bundles share one cache (same pattern as the api-security rate limiter).

import type { SearchResult } from "@/lib/search";

export const ASK_CACHE_TTL_MS = 10 * 60_000;

export type AskCacheOrigin = "ask" | "context_card";

export interface AskCacheValue {
  results: SearchResult[];
  origin: AskCacheOrigin;
}

interface AskCacheEntry extends AskCacheValue {
  expiresAt: number;
}

export interface AskCache {
  get(term: string): AskCacheValue | null;
  set(term: string, results: SearchResult[], origin?: AskCacheOrigin): void;
  clear(): void;
}

/** Factory with an injectable clock so tests can advance time deterministically. */
export function createAskCache(now: () => number = Date.now): AskCache {
  const store = new Map<string, AskCacheEntry>();
  const normalize = (term: string): string => term.trim().toLowerCase();
  return {
    get(term: string): AskCacheValue | null {
      const key = normalize(term);
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return { results: entry.results, origin: entry.origin };
    },
    set(term: string, results: SearchResult[], origin: AskCacheOrigin = "ask"): void {
      store.set(normalize(term), {
        expiresAt: now() + ASK_CACHE_TTL_MS,
        results,
        origin,
      });
    },
    clear(): void {
      store.clear();
    },
  };
}

const globalAskCache = globalThis as typeof globalThis & {
  cueMindAskCache?: AskCache;
};
const askCache = globalAskCache.cueMindAskCache ?? createAskCache();
globalAskCache.cueMindAskCache = askCache;

export function askCacheGet(term: string): AskCacheValue | null {
  return askCache.get(term);
}

export function askCacheSet(
  term: string,
  results: SearchResult[],
  origin: AskCacheOrigin = "ask",
): void {
  askCache.set(term, results, origin);
}

export function askCacheClear(): void {
  askCache.clear();
}
