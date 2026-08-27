// Hacker News (Algolia) search adapter (keyless). Maps story hits to VerticalResult.

export interface VerticalResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: "hackernews";
}

export async function searchHackerNews(
  keyword: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerticalResult[]> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=3`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Hacker News returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const hits = isRecord(payload) && Array.isArray(payload.hits) ? payload.hits : [];
    return hits.flatMap((hit) => {
      if (!isRecord(hit)) return [];
      const title = firstString(hit.title, hit.story_title);
      if (!title) return [];
      const objectID = isString(hit.objectID) ? hit.objectID : "";
      const url = firstString(hit.url, hit.story_url) ??
        (objectID ? `https://news.ycombinator.com/item?id=${objectID}` : "");
      if (!url || !/^https?:\/\//.test(url)) return [];
      const storyText = isString(hit.story_text) ? collapseWhitespace(stripHtml(hit.story_text)) : "";
      return [{
        title: collapseWhitespace(title),
        url,
        snippet: storyText.slice(0, 300),
        sourceType: "hackernews" as const,
      }];
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (isString(value) && value.trim()) return value;
  }
  return null;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
