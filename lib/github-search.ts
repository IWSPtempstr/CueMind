// GitHub repository search adapter (keyless, anonymous 10 req/min quota).

export interface VerticalResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: "github";
}

export async function searchGithub(
  keyword: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerticalResult[]> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&per_page=3`;
    const response = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "CueMind" },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        throw new Error(`GitHub search rate limited (HTTP ${response.status})`);
      }
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
    return items.flatMap((item) => {
      if (!isRecord(item) || !isString(item.full_name) || !isString(item.html_url)) return [];
      const url = item.html_url.trim();
      if (!/^https?:\/\//.test(url)) return [];
      const description = isString(item.description) ? collapseWhitespace(item.description) : "";
      return [{
        title: description ? `${item.full_name}: ${description.slice(0, 100)}` : item.full_name,
        url,
        snippet: description.slice(0, 300),
        sourceType: "github" as const,
      }];
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
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
