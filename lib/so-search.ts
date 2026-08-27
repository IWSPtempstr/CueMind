// Stack Overflow (Stack Exchange advanced search) adapter (keyless).
// intitle matching; the default filter does not return excerpt, so tags form the snippet.

export interface VerticalResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: "stackoverflow";
}

export function hyphenateKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, "-");
}

export async function searchStackOverflow(
  keyword: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerticalResult[]> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const url = `https://api.stackexchange.com/2.3/search/advanced?intitle=${encodeURIComponent(hyphenateKeyword(keyword))}&order=desc&sort=relevance&site=stackoverflow&pagesize=3`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Stack Overflow returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    return items.flatMap((item) => {
      if (!isRecord(item) || !isString(item.title) || !isString(item.link)) return [];
      const url = item.link.trim();
      if (!/^https?:\/\//.test(url)) return [];
      const tags = Array.isArray(item.tags) ? item.tags.filter(isString) : [];
      return [{
        title: collapseWhitespace(decodeHtmlEntities(item.title)),
        url,
        snippet: tags.length ? `[${tags.slice(0, 5).join(", ")}]` : "",
        sourceType: "stackoverflow" as const,
      }];
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
