import {
  AgentReachSearchError,
  searchWithAgentReach,
} from "@/lib/agent-reach-search";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchExecution {
  provider: "tavily" | "bing" | "serpapi" | "agent-reach";
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
  const seenUrls = new Set<string>();
  const usable: SearchResult[] = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const title = typeof result.title === "string" ? result.title.trim() : "";
    const snippet = typeof result.snippet === "string" ? result.snippet.trim() : "";
    const url = normalizeHttpUrl(result.url);
    if (!title || !snippet || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    usable.push({ title, url, snippet });
    if (usable.length === 5) break;
  }
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
