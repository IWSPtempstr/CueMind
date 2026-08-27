import {
  AgentReachSearchError,
  searchWithAgentReach,
} from "@/lib/agent-reach-search";
import { searchArxiv } from "@/lib/arxiv-search";
import { searchGithub } from "@/lib/github-search";
import { searchHackerNews } from "@/lib/hn-search";
import { searchStackOverflow } from "@/lib/so-search";

export type SearchResultSourceType =
  | "arxiv"
  | "hackernews"
  | "github"
  | "stackoverflow"
  | "web";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceType?: SearchResultSourceType;
}

export interface SearchExecution {
  provider: "tavily" | "bing" | "serpapi" | "agent-reach" | "vertical";
  fallbackUsed: boolean;
  results: SearchResult[];
}

export class InsufficientSearchSourcesError extends Error {
  constructor(message = "Search returned fewer than two usable sources") {
    super(message);
    this.name = "InsufficientSearchSourcesError";
  }
}

export async function searchWeb(args: {
  provider: "tavily" | "bing" | "serpapi";
  apiKey: string;
  query: string;
  timeoutMs: number;
  enableAgentReachFallback?: boolean;
}): Promise<SearchExecution> {
  if (args.provider !== "tavily" && !args.apiKey.trim()) {
    throw new Error("Search API key is not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    if (args.provider === "tavily") {
      return await searchTavilyWithFallback(args, controller.signal);
    }
    const results = await ({
      bing: searchBing,
      serpapi: searchSerpApi,
    }[args.provider])(args, controller.signal);
    return {
      provider: args.provider,
      fallbackUsed: false,
      results: ensureUsableResults(results),
    };
  } catch (caught) {
    if (caught instanceof AgentReachSearchError) throw caught;
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw new Error(`Search timed out after ${args.timeoutMs}ms`);
    }
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

const VERTICAL_SEARCH_TIMEOUT_MS = 2_500;
const DEFAULT_KEYWORD_TIMEOUT_MS = 4_000;
const VERTICAL_MAX_RESULTS = 5;
const VERTICAL_MIN_USABLE_RESULTS = 2;

export interface SearchKeywordOutcome extends SearchExecution {
  verticalHit: boolean;
}

// Two-level retrieval: four keyless vertical sources in parallel first (raw
// keyword, 2.5s budget each); with >=2 usable results it short-circuits as
// provider "vertical", otherwise it falls back to the existing Tavily ->
// agent-reach chain with the current suffixed query.
export async function searchKeywordSources(args: {
  keyword: string;
  tavilyApiKey?: string;
  enableAgentReachFallback?: boolean;
  timeoutMs?: number;
}): Promise<SearchKeywordOutcome> {
  const fallbackTimeoutMs = args.timeoutMs ?? DEFAULT_KEYWORD_TIMEOUT_MS;
  const settled = await Promise.allSettled<SearchResult[]>([
    withTimeout(
      (signal) => searchArxiv(args.keyword, VERTICAL_SEARCH_TIMEOUT_MS, signal),
      VERTICAL_SEARCH_TIMEOUT_MS,
    ),
    withTimeout(
      (signal) => searchHackerNews(args.keyword, VERTICAL_SEARCH_TIMEOUT_MS, signal),
      VERTICAL_SEARCH_TIMEOUT_MS,
    ),
    withTimeout(
      (signal) => searchGithub(args.keyword, VERTICAL_SEARCH_TIMEOUT_MS, signal),
      VERTICAL_SEARCH_TIMEOUT_MS,
    ),
    withTimeout(
      (signal) => searchStackOverflow(args.keyword, VERTICAL_SEARCH_TIMEOUT_MS, signal),
      VERTICAL_SEARCH_TIMEOUT_MS,
    ),
  ]);
  const merged = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
  const usable = collectUsableResults(merged);
  if (usable.length >= VERTICAL_MIN_USABLE_RESULTS) {
    return { provider: "vertical", fallbackUsed: false, results: usable, verticalHit: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fallbackTimeoutMs);
  try {
    const execution = await searchTavilyWithFallback(
      {
        apiKey: args.tavilyApiKey ?? "",
        query: `${args.keyword} technology explanation`,
        timeoutMs: fallbackTimeoutMs,
        enableAgentReachFallback: args.enableAgentReachFallback,
      },
      controller.signal,
    );
    return { ...execution, verticalHit: false };
  } catch (caught) {
    if (caught instanceof AgentReachSearchError) throw caught;
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw new Error(`Search timed out after ${fallbackTimeoutMs}ms`);
    }
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

// Bounded run: aborts the passed signal on deadline and rejects with a timeout
// error, so a hung vertical source can never stall the parallel stage.
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await run(controller.signal);
  } catch (caught) {
    if (timedOut) throw new Error(`Vertical source timed out after ${timeoutMs}ms`);
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

// Dedupe/validate/cap without throwing, so the vertical stage can fall back to
// Tavily on shortage instead of failing the whole pipeline.
export function collectUsableResults(results: SearchResult[]): SearchResult[] {
  const seenUrls = new Set<string>();
  const usable: SearchResult[] = [];
  for (const result of results) {
    if (usable.length === VERTICAL_MAX_RESULTS) break;
    if (!result || typeof result !== "object") continue;
    const title = typeof result.title === "string" ? result.title.trim() : "";
    const snippet = typeof result.snippet === "string" ? result.snippet.trim() : "";
    const url = normalizeHttpUrl(result.url);
    if (!title || !snippet || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    usable.push(
      result.sourceType === undefined
        ? { title, url, snippet }
        : { title, url, snippet, sourceType: result.sourceType },
    );
  }
  return usable;
}

async function searchTavilyWithFallback(
  args: { apiKey: string; query: string; timeoutMs: number; enableAgentReachFallback?: boolean },
  signal: AbortSignal,
): Promise<SearchExecution> {
  try {
    if (!args.apiKey.trim()) {
      throw new Error("Search API key is not configured");
    }
    const results = await searchTavily(args, signal);
    return {
      provider: "tavily",
      fallbackUsed: false,
      results: ensureUsableResults(results),
    };
  } catch (caught) {
    if (args.enableAgentReachFallback === false || !shouldFallbackToAgentReach(caught)) throw caught;
    return {
      provider: "agent-reach",
      fallbackUsed: true,
      results: await searchWithAgentReach({
        query: args.query,
        timeoutMs: args.timeoutMs,
      }),
    };
  }
}

async function searchTavily(args: { apiKey: string; query: string }, signal: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: args.apiKey, query: args.query, max_results: 5, search_depth: "basic" }),
    signal,
  });
  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  return results.flatMap((result) => {
    if (!isRecord(result) || !isString(result.title) || !isString(result.url)) return [];
    return [{ title: result.title, url: result.url, snippet: isString(result.content) ? result.content : "" }];
  });
}

async function searchBing(args: { apiKey: string; query: string }, signal: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(args.query)}&count=5`, {
    headers: { "Ocp-Apim-Subscription-Key": args.apiKey },
    signal,
  });
  if (!response.ok) throw new Error(`Bing returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const results = isRecord(payload) && isRecord(payload.webPages) && Array.isArray(payload.webPages.value) ? payload.webPages.value : [];
  return results.flatMap((result) => {
    if (!isRecord(result) || !isString(result.name) || !isString(result.url)) return [];
    return [{ title: result.name, url: result.url, snippet: isString(result.snippet) ? result.snippet : "" }];
  });
}

async function searchSerpApi(args: { apiKey: string; query: string }, signal: AbortSignal): Promise<SearchResult[]> {
  const response = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(args.query)}&api_key=${encodeURIComponent(args.apiKey)}`, { signal });
  if (!response.ok) throw new Error(`SerpAPI returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const results = isRecord(payload) && Array.isArray(payload.organic_results) ? payload.organic_results : [];
  return results.flatMap((result) => {
    if (!isRecord(result) || !isString(result.title) || !isString(result.link)) return [];
    return [{ title: result.title, url: result.link, snippet: isString(result.snippet) ? result.snippet : "" }];
  });
}

function ensureUsableResults(results: SearchResult[]): SearchResult[] {
  const usable = collectUsableResults(results);
  if (usable.length < 2) throw new InsufficientSearchSourcesError();
  return usable;
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function shouldFallbackToAgentReach(error: unknown): boolean {
  if (error instanceof InsufficientSearchSourcesError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  if (error.message === "Search API key is not configured") return true;
  const httpStatus = error.message.match(/Tavily returned HTTP (\d+)/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  const errorCode = "code" in error && typeof error.code === "string" ? error.code : "";
  return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(errorCode) ||
    error.message === "fetch failed";
}
