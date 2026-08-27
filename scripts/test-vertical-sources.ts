// Vertical-sources two-level retrieval regression tests (V5).
// Style follows scripts/test-model-providers.ts: node:assert, one try/catch per
// case, exit(1) on failure, success message on the end.

import assert from "node:assert/strict";
import { searchGithub } from "@/lib/github-search";
import { searchHackerNews } from "@/lib/hn-search";
import { searchArxiv } from "@/lib/arxiv-search";
import { searchStackOverflow, hyphenateKeyword } from "@/lib/so-search";
import {
  InsufficientSearchSourcesError,
  collectUsableResults,
  searchKeywordSources,
  searchWeb,
} from "@/lib/search";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const realFetch = globalThis.fetch;
const freshSignal = (): AbortSignal => new AbortController().signal;

let tavilyCalls = 0;
let tavilyBody = "";
let responder: (url: string, init?: FetchInit) => Response = () =>
  new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.tavily.com")) {
      tavilyCalls += 1;
      tavilyBody = typeof init?.body === "string" ? init.body : "";
    }
    return responder(url, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function makeArxivFeed(entries: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "<title>ArXiv Query</title>",
    ...entries,
    "</feed>",
  ].join("\n");
}

function arxivEntry(id: string, title: string, summary: string): string {
  return `<entry><id>${id}</id><title>${title}</title><summary>${summary}</summary></entry>`;
}

// --- a) arXiv Atom parsing ---

async function testArxivAtomParsing(): Promise<void> {
  responder = (url) => {
    assert.ok(url.includes("export.arxiv.org/api/query"));
    return new Response(makeArxivFeed([
      arxivEntry(
        "http://arxiv.org/abs/2401.00001v2",
        "Efficient KV Cache\n    Management",
        "We study kv cache eviction\n      policies   for LLM inference.",
      ),
      arxivEntry(
        "http://arxiv.org/abs/2402.00002v1",
        "Speculative Decoding Survey",
        "A survey of &amp; speculative decoding with &lt;tags&gt;.",
      ),
    ]), { status: 200, headers: { "Content-Type": "application/atom+xml" } });
  };
  const results = await searchArxiv("kv cache", 1_000, freshSignal());
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Efficient KV Cache Management");
  assert.equal(results[0].url, "http://arxiv.org/abs/2401.00001v2");
  assert.equal(results[0].snippet, "We study kv cache eviction policies for LLM inference.");
  assert.equal(results[0].sourceType, "arxiv");
  assert.equal(results[1].title, "Speculative Decoding Survey");
  assert.equal(results[1].snippet, "A survey of & speculative decoding with <tags>.");
}

// --- b) Hacker News parsing with objectID fallback ---

async function testHackerNewsParsing(): Promise<void> {
  responder = (url) => {
    assert.ok(url.includes("hn.algolia.com/api/v1/search"));
    return jsonResponse({
      hits: [
        {
          objectID: "1001",
          title: "Show HN: CueMind",
          url: "https://example.com/cuemind",
          story_text: "<p>Hello <b>world</b> of <a href=\"x\">agents</a></p>",
        },
        {
          objectID: "2002",
          title: null,
          story_title: "Ask HN: rag in production",
          url: null,
          story_url: null,
        },
      ],
    });
  };
  const results = await searchHackerNews("agent harness", 1_000, freshSignal());
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Show HN: CueMind");
  assert.equal(results[0].url, "https://example.com/cuemind");
  assert.equal(results[0].snippet, "Hello world of agents");
  assert.equal(results[0].sourceType, "hackernews");
  assert.equal(results[1].title, "Ask HN: rag in production");
  assert.equal(results[1].url, "https://news.ycombinator.com/item?id=2002");
  assert.equal(results[1].snippet, "");
}

// --- c) GitHub parsing (full_name + description, User-Agent header) ---

async function testGithubParsing(): Promise<void> {
  let seenInit: FetchInit | undefined;
  responder = (url, init) => {
    seenInit = init;
    assert.ok(url.includes("api.github.com/search/repositories"));
    return jsonResponse({
      items: [
        {
          full_name: "user/llama-cpp",
          html_url: "https://github.com/user/llama-cpp",
          description: "Fast LLM inference on CPU",
          stargazers_count: 42000,
        },
        { full_name: "user/no-desc", html_url: "https://github.com/user/no-desc", description: null },
      ],
    });
  };
  const results = await searchGithub("llama cpp", 1_000, freshSignal());
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "user/llama-cpp: Fast LLM inference on CPU");
  assert.equal(results[0].url, "https://github.com/user/llama-cpp");
  assert.equal(results[0].snippet, "Fast LLM inference on CPU");
  assert.equal(results[0].sourceType, "github");
  assert.equal(results[1].title, "user/no-desc");
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get("User-Agent"), "CueMind");
  assert.equal(headers.get("Accept"), "application/vnd.github+json");
}

// --- d) Stack Overflow hyphenate + intitle URL + entity decoding ---

async function testStackOverflowHyphenateAndEntities(): Promise<void> {
  assert.equal(hyphenateKeyword("Speculative Decoding"), "speculative-decoding");
  assert.equal(hyphenateKeyword("  Mixed  CASE keyword "), "mixed-case-keyword");
  let soUrl = "";
  responder = (url) => {
    soUrl = url;
    return jsonResponse({
      items: [
        {
          title: "How to handle &#39;quotes&#39; &amp; &lt;tags&gt; in JSON?",
          link: "https://stackoverflow.com/questions/111/json-quotes",
          tags: ["json", "encoding", "strings"],
        },
      ],
    });
  };
  const results = await searchStackOverflow("Speculative Decoding", 1_000, freshSignal());
  assert.ok(soUrl.includes("intitle=speculative-decoding"));
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "How to handle 'quotes' & <tags> in JSON?");
  assert.equal(results[0].url, "https://stackoverflow.com/questions/111/json-quotes");
  assert.equal(results[0].snippet, "[json, encoding, strings]");
  assert.equal(results[0].sourceType, "stackoverflow");
}

// --- e) merge + dedupe, >=2 usable results short-circuits Tavily ---

async function testVerticalMergeDedupShortCircuitsTavily(): Promise<void> {
  tavilyCalls = 0;
  const sharedUrl = "http://arxiv.org/abs/1111.0001v1";
  responder = (url) => {
    if (url.includes("export.arxiv.org")) {
      return new Response(makeArxivFeed([
        arxivEntry(sharedUrl, "Paper A", "Paper A summary."),
        arxivEntry("http://arxiv.org/abs/2222.0002v1", "Paper B", "Paper B summary."),
      ]), { status: 200 });
    }
    if (url.includes("hn.algolia.com")) {
      return jsonResponse({
        hits: [
          { objectID: "9", title: "Paper A discussion", url: sharedUrl, story_text: "same paper" },
          { objectID: "10", title: "Another HN story", url: "https://example.com/hn2", story_text: "hn2 text" },
        ],
      });
    }
    return jsonResponse({ items: [] });
  };
  const outcome = await searchKeywordSources({ keyword: "kv cache", tavilyApiKey: "unused", timeoutMs: 1_000 });
  assert.equal(outcome.provider, "vertical");
  assert.equal(outcome.verticalHit, true);
  assert.equal(outcome.fallbackUsed, false);
  assert.equal(outcome.results.length, 3);
  assert.equal(outcome.results[0].url, "http://arxiv.org/abs/1111.0001v1");
  assert.equal(outcome.results[0].sourceType, "arxiv");
  assert.equal(outcome.results[2].sourceType, "hackernews");
  assert.equal(tavilyCalls, 0);
}

// --- f) one rejected source is tolerated when another yields >=2 ---

async function testSingleSourceFailureTolerated(): Promise<void> {
  tavilyCalls = 0;
  responder = (url) => {
    if (url.includes("export.arxiv.org")) {
      return jsonResponse({ error: "boom" }, 503);
    }
    if (url.includes("hn.algolia.com")) {
      return jsonResponse({
        hits: [
          { objectID: "1", title: "HN one", url: "https://example.com/one", story_text: "one" },
          { objectID: "2", title: "HN two", url: "https://example.com/two", story_text: "two" },
        ],
      });
    }
    return jsonResponse({ items: [] });
  };
  const outcome = await searchKeywordSources({ keyword: "rag", timeoutMs: 1_000 });
  assert.equal(outcome.provider, "vertical");
  assert.equal(outcome.verticalHit, true);
  assert.equal(outcome.results.length, 2);
  assert.equal(tavilyCalls, 0);
}

// --- g) all vertical sources empty -> Tavily fallback ---

async function testAllSourcesEmptyFallsBackToTavily(): Promise<void> {
  tavilyCalls = 0;
  tavilyBody = "";
  responder = (url) => {
    if (url.includes("export.arxiv.org")) {
      return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
    }
    if (url.includes("api.tavily.com")) {
      return jsonResponse({
        results: [
          { title: "T1", url: "https://example.com/t1", content: "c1" },
          { title: "T2", url: "https://example.com/t2", content: "c2" },
          { title: "T3", url: "https://example.com/t3", content: "c3" },
        ],
      });
    }
    return jsonResponse({ items: [] });
  };
  const outcome = await searchKeywordSources({ keyword: "obscurum", tavilyApiKey: "test-key", timeoutMs: 1_000 });
  assert.equal(outcome.provider, "tavily");
  assert.equal(outcome.verticalHit, false);
  assert.equal(outcome.fallbackUsed, false);
  assert.equal(outcome.results.length, 3);
  assert.equal(tavilyCalls, 1);
  const sent = JSON.parse(tavilyBody) as { api_key: string; query: string };
  assert.equal(sent.api_key, "test-key");
  assert.equal(sent.query, "obscurum technology explanation");
}

// --- h) fallback also short -> InsufficientSearchSourcesError ---

async function testFallbackShortageThrows(): Promise<void> {
  responder = (url) => {
    if (url.includes("export.arxiv.org")) {
      return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 });
    }
    if (url.includes("api.tavily.com")) {
      return jsonResponse({ results: [{ title: "Only one", url: "https://example.com/only", content: "c" }] });
    }
    return jsonResponse({ items: [] });
  };
  await assert.rejects(
    () => searchKeywordSources({ keyword: "scarce", tavilyApiKey: "test-key", enableAgentReachFallback: false, timeoutMs: 1_000 }),
    (error: unknown) => error instanceof InsufficientSearchSourcesError,
  );
}

// --- i) searchWeb("tavily") original path unchanged ---

async function testSearchWebTavilyPathUnchanged(): Promise<void> {
  responder = (url) => {
    assert.ok(url.includes("api.tavily.com"));
    return jsonResponse({
      results: [
        { title: "T1", url: "https://example.com/t1", content: "c1" },
        { title: "T2", url: "https://example.com/t2", content: "c2" },
      ],
    });
  };
  const execution = await searchWeb({
    provider: "tavily",
    apiKey: "test-key",
    query: "plain query",
    timeoutMs: 1_000,
    enableAgentReachFallback: false,
  });
  assert.equal(execution.provider, "tavily");
  assert.equal(execution.fallbackUsed, false);
  assert.deepEqual(
    execution.results.map((result) => [result.title, result.url, result.snippet]),
    [["T1", "https://example.com/t1", "c1"], ["T2", "https://example.com/t2", "c2"]],
  );

  responder = () => jsonResponse({ results: [{ title: "T1", url: "https://example.com/t1", content: "c1" }] });
  await assert.rejects(
    () => searchWeb({
      provider: "tavily",
      apiKey: "test-key",
      query: "plain query",
      timeoutMs: 1_000,
      enableAgentReachFallback: false,
    }),
    (error: unknown) => error instanceof InsufficientSearchSourcesError,
  );
}

// --- j) collectUsableResults filters invalid urls / empty fields / dedupes / caps ---

function testCollectUsableResultsFilters(): void {
  const collected = collectUsableResults([
    { title: "", url: "https://example.com/a", snippet: "s" },
    { title: "T", url: "ftp://example.com/b", snippet: "s" },
    { title: "T", url: "not a url", snippet: "s" },
    { title: "T", url: "javascript:alert(1)", snippet: "s" },
    { title: "T", url: "https://example.com/c", snippet: "" },
    { title: "Hashed", url: "https://example.com/d#frag", snippet: "s" },
    { title: "Duplicate", url: "https://example.com/d", snippet: "s2" },
    { title: "Keep 1", url: "https://example.com/e", snippet: "s", sourceType: "github" },
    { title: "Keep 2", url: "https://example.com/f", snippet: "s", sourceType: "arxiv" },
    { title: "Keep 3", url: "https://example.com/g", snippet: "s", sourceType: "hackernews" },
    { title: "Keep 4", url: "https://example.com/h", snippet: "s", sourceType: "stackoverflow" },
    { title: "Keep 5", url: "https://example.com/i", snippet: "s" },
    { title: "Capped out", url: "https://example.com/j", snippet: "s" },
  ]);
  assert.equal(collected.length, 5);
  assert.equal(collected[0].url, "https://example.com/d");
  assert.equal(collected[1].sourceType, "github");
  assert.equal(collected[4].url, "https://example.com/h");
  assert.equal(collected[4].sourceType, "stackoverflow");
  assert.equal(collected.some((result) => result.url === "https://example.com/i"), false);
  assert.equal(collected.some((result) => result.url.includes("#frag")), false);
}

// --- runner ---

interface TestCase {
  name: string;
  run: () => void | Promise<void>;
}

const tests: TestCase[] = [
  { name: "a) arXiv Atom parsing (title/summary/id->url/sourceType)", run: testArxivAtomParsing },
  { name: "b) HN parsing with objectID url fallback + html strip", run: testHackerNewsParsing },
  { name: "c) GitHub parsing (full_name + description, headers)", run: testGithubParsing },
  { name: "d) hyphenateKeyword + intitle URL + entity decoding", run: testStackOverflowHyphenateAndEntities },
  { name: "e) merge dedupe >=2 short-circuits Tavily (verticalHit)", run: testVerticalMergeDedupShortCircuitsTavily },
  { name: "f) single rejected source tolerated (HN 2 -> verticalHit)", run: testSingleSourceFailureTolerated },
  { name: "g) all sources empty -> Tavily fallback (verticalHit=false)", run: testAllSourcesEmptyFallsBackToTavily },
  { name: "h) fallback <2 -> InsufficientSearchSourcesError", run: testFallbackShortageThrows },
  { name: "i) searchWeb('tavily') path unchanged (mapping + fallback switch)", run: testSearchWebTavilyPathUnchanged },
  { name: "j) collectUsableResults filters/dedupes/caps", run: testCollectUsableResultsFilters },
];

async function main(): Promise<void> {
  installFetchMock();
  const failed: string[] = [];
  for (const test of tests) {
    tavilyCalls = 0;
    tavilyBody = "";
    try {
      await test.run();
      console.log(`ok - ${test.name}`);
    } catch (error) {
      failed.push(test.name);
      console.error(`FAIL - ${test.name}`);
      console.error(error);
    }
  }
  restoreFetch();
  if (failed.length > 0) {
    console.error(`${failed.length}/${tests.length} vertical source test(s) failed`);
    process.exit(1);
  }
  console.log("vertical sources regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
