// arXiv Atom API search adapter (keyless). Zero-dependency Atom XML parsing.

export interface VerticalResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: "arxiv";
}

export async function searchArxiv(
  keyword: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerticalResult[]> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const url = `http://export.arxiv.org/api/query?search_query=all:"${encodeURIComponent(keyword)}"&max_results=3&sortBy=relevance`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`arXiv returned HTTP ${response.status}`);
    return parseArxivAtom(await response.text());
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function parseArxivAtom(xml: string): VerticalResult[] {
  if (!xml.includes("<feed")) {
    throw new Error("arXiv returned a malformed Atom feed");
  }
  const results: VerticalResult[] = [];
  for (const chunk of xml.split("<entry>").slice(1)) {
    const entry = chunk.split("</entry>")[0] ?? "";
    const title = extractAtomTag(entry, "title");
    const id = extractAtomTag(entry, "id");
    if (title === null || id === null) continue;
    const url = decodeXmlEntities(id).trim();
    if (!/^https?:\/\//.test(url)) continue;
    const summary = extractAtomTag(entry, "summary") ?? "";
    results.push({
      title: collapseWhitespace(decodeXmlEntities(title)),
      url,
      snippet: collapseWhitespace(decodeXmlEntities(summary)).slice(0, 300),
      sourceType: "arxiv",
    });
  }
  return results;
}

function extractAtomTag(entry: string, tag: string): string | null {
  const match = entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
