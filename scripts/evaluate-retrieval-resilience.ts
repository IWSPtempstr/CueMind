import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAskCache } from "@/lib/ask-cache";
import { classifyCacheObservation, type CacheObservation } from "@/lib/retrieval-resilience";
import { searchKeywordSources } from "@/lib/search";

type SearchScenario = "single_vertical_timeout" | "vertical_fallback" | "all_sources_timeout";
type FixtureCase = {
  id: string;
  kind: "search" | "cache";
  scenario?: SearchScenario;
  observation?: CacheObservation;
  term?: string;
  lookup?: string;
  expected: string;
};

const fixturePath = resolve(process.argv[2] ?? process.env.RETRIEVAL_RESILIENCE_FIXTURE ?? "fixtures/retrieval-resilience-v1.json");
const outputDir = resolve(process.argv[3] ?? process.env.RETRIEVAL_RESILIENCE_OUTPUT ?? `reports/retrieval-resilience/${new Date().toISOString().replace(/[:.]/g, "-")}`);
const realFetch = globalThis.fetch;

function result(title: string, url: string, content: string): { title: string; url: string; content: string } {
  return { title, url, content };
}

function mockFetch(scenario: SearchScenario): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (scenario === "single_vertical_timeout" && url.includes("export.arxiv.org")) {
      throw new DOMException("timed out", "AbortError");
    }
    if (scenario === "vertical_fallback" && url.includes("api.tavily.com")) {
      return new Response(JSON.stringify({ results: [result("Fallback A", "https://example.com/a", "A"), result("Fallback B", "https://example.com/b", "B")] }), { status: 200 });
    }
    if (scenario === "all_sources_timeout") {
      throw new DOMException("timed out", "AbortError");
    }
    if (scenario === "single_vertical_timeout" && (url.includes("hn.algolia.com") || url.includes("api.github.com") || url.includes("api.stackexchange.com"))) {
      return new Response(JSON.stringify({ hits: [{ objectID: "1", title: "Vertical A", url: "https://example.com/a", story_text: "A" }, { objectID: "2", title: "Vertical B", url: "https://example.com/b", story_text: "B" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { version: string; cases: FixtureCase[] };
  const cases: Array<Record<string, unknown>> = [];
  for (const testCase of fixture.cases) {
    const started = Date.now();
    let actual = "";
    let status = "pass";
    let failure: string | undefined;
    if (testCase.kind === "cache") {
      try {
        if (testCase.observation) actual = classifyCacheObservation(testCase.observation);
        else {
          const cache = createAskCache(() => 1_000);
          cache.set(testCase.term ?? "", [], "ask");
          const hit = cache.get(testCase.lookup ?? "");
          actual = hit ? "ask_hot_hit" : "expired_miss";
        }
      } catch (error) {
        status = "failed";
        failure = error instanceof Error ? error.message : "cache classification failed";
      }
    } else {
      const scenario = testCase.scenario as SearchScenario;
      globalThis.fetch = mockFetch(scenario);
      try {
        const outcome = await searchKeywordSources({ keyword: "kv cache", tavilyApiKey: "fixture-key", enableAgentReachFallback: false, timeoutMs: 30 });
        actual = outcome.verticalHit ? "vertical_success" : "generic_fallback";
      } catch (error) {
        actual = "search_failed";
        failure = error instanceof Error ? error.message : "search failed";
      } finally {
        globalThis.fetch = realFetch;
      }
    }
    if (actual !== testCase.expected) status = "failed";
    cases.push({ id: testCase.id, kind: testCase.kind, expected: testCase.expected, actual, status, failure, durationMs: Date.now() - started });
  }
  const failures = cases.filter((item) => item.status === "failed");
  const scorecard = {
    evaluator: "retrieval-resilience-evaluator-v1",
    datasetVersion: fixture.version,
    status: failures.length === 0 ? "complete" : "failed",
    denominator: { totalCases: cases.length, scoredCases: cases.length, excludedCases: 0, freezeExcluded: 0 },
    metrics: { passRate: cases.length === 0 ? null : (cases.length - failures.length) / cases.length },
    failureCounts: failures.reduce<Record<string, number>>((counts, item) => { const key = String(item.actual); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
    evidenceBoundary: "fixture_only; does not prove live network availability or source quality",
  };
  const manifest = { evaluator: "retrieval-resilience-evaluator-v1", fixturePath, datasetVersion: fixture.version, executionMode: "fixture", generatedAt: new Date().toISOString(), cacheClassifications: ["cold_miss", "card_warmed_hit", "ask_hot_hit", "expired_miss"], freezeExcluded: 0 };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(outputDir, "cases.jsonl"), cases.map((item) => JSON.stringify(item)).join("\n") + "\n"),
    writeFile(resolve(outputDir, "failures.jsonl"), failures.map((item) => JSON.stringify(item)).join("\n") + (failures.length ? "\n" : "")),
    writeFile(resolve(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(resolve(outputDir, "report.md"), `# Retrieval resilience report\n\n- Status: ${scorecard.status}\n- Cases: ${cases.length}\n- Pass rate: ${scorecard.metrics.passRate ?? "n/a"}\n- Evidence: ${scorecard.evidenceBoundary}\n`),
  ]);
  console.log(`Retrieval resilience report written to ${outputDir}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
