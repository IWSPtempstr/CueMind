export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
}): Promise<SearchResult[]> {
  if (!args.apiKey.trim()) throw new Error("Search API key is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const results = await ({
      tavily: searchTavily,
      bing: searchBing,
      serpapi: searchSerpApi,
    }[args.provider])(args, controller.signal);
    const usable = results.filter((result) => isHttpUrl(result.url)).slice(0, 5);
    if (usable.length < 2) throw new InsufficientSearchSourcesError();
    return usable;
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw new Error(`Search timed out after ${args.timeoutMs}ms`);
    }
    throw caught;
  } finally {
    clearTimeout(timer);
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
