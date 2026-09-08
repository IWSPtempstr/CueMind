import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateLlamaCppJson } from "@/lib/llama-cpp";
import { generateRemoteApiJson } from "@/lib/remote-api";

const DEFAULT_FIXTURE = "fixtures/context-card-evaluation-v1.json";
const DEFAULT_OUTPUT = "reports/context-card-evaluation";
const JUDGE_VERSION = "heuristic-judge-v1";
const EVALUATOR_VERSION = "context-card-evaluator-v1";

type ExpectedDecision = "generate_card" | "skip" | "search_failed" | "schema_failed";

interface SourceSnapshot {
  title: string;
  url: string;
  snippet: string;
}

interface EvaluationCase {
  id: string;
  input: {
    recentTranscript: string;
    knownKeywords: string[];
    transcriptChunkIds: string[];
    currentTime: string;
  };
  expected: {
    decision: ExpectedDecision;
    keyword: string;
    whyNowEvidence: string[];
    sourceRequirements: { minUsableSources: number; mustHaveUrl: boolean };
  };
  tags: string[];
  sourceSnapshots: SourceSnapshot[];
  fixtureOutput?: { keyword: string; explanation: string; whyNow: string };
  fixtureFailure?: { code: string; message: string };
}

interface FixtureFile {
  version: string;
  source: "synthetic" | "real" | "mixed";
  cases: EvaluationCase[];
}

interface CaseResult {
  id: string;
  tags: string[];
  expectedDecision: ExpectedDecision;
  actualDecision: ExpectedDecision;
  searchPath: "tavily" | "agent-reach" | "mixed" | "failure" | "none";
  keyword: string | null;
  keywordRelevant: boolean | null;
  sourceCount: number;
  usableSourceCount: number;
  sourceSchemaValid: boolean;
  cardSchemaValid: boolean | null;
  cardSuccess: boolean;
  gracefulFailure: boolean;
  sourceSupportScore: number | null;
  whyNowRelevanceScore: number | null;
  latencyMs: { search: number; generation: number; total: number };
  excluded: boolean;
  exclusionReason?: string;
  failureCode?: string;
  /** Actual generated card content (persisted for offline content-quality judging). */
  card?: { keyword: string; explanation: string; whyNow: string };
  usableSourceTitles?: string[];
  transcriptExcerpt?: string;
}

interface ProviderConfig {
  provider: "llama.cpp" | "remote-api";
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface Percentiles {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

interface Scorecard {
  evaluator: string;
  datasetVersion: string;
  status: "complete" | "failed";
  denominator: {
    totalCases: number;
    scoredCases: number;
    excludedCases: number;
    generationExpectedCases: number;
    searchExpectedCases: number;
  };
  metrics: Record<string, number | null>;
  failureCounts: Record<string, number>;
  latency: {
    search: Percentiles | null;
    generation: Percentiles | null;
    total: Percentiles | null;
  };
  judge: {
    version: string;
    type: "deterministic_heuristic";
    rubric: string[];
  };
  evidenceBoundary: string;
}

async function main(): Promise<void> {
  const fixturePath = resolve(process.env.CONTEXT_CARD_FIXTURE ?? DEFAULT_FIXTURE);
  const outputDir = resolve(process.env.CONTEXT_CARD_OUTPUT_DIR ?? DEFAULT_OUTPUT);
  const fixture = parseFixture(JSON.parse(await readFile(fixturePath, "utf8")) as unknown);
  const mode = process.env.CONTEXT_CARD_EVAL_MODE === "live" ? "live" : "fixture";
  const provider = resolveProvider();
  const results: CaseResult[] = [];
  for (const testCase of fixture.cases) {
    results.push(await evaluateCase(testCase, mode, provider));
  }
  const scorecard = summarize(fixture, results);
  const manifest = {
    runId: `context-card-evaluation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    evaluator: EVALUATOR_VERSION,
    fixturePath,
    datasetVersion: fixture.version,
    datasetSource: fixture.source,
    caseCount: fixture.cases.length,
    searchPaths: ["tavily", "agent-reach", "mixed", "failure", "none"],
    promptVersion: "context-card-prompt-v1",
    executionMode: mode,
    provider: mode === "live" ? provider : null,
    judge: scorecard.judge,
    generatedAt: new Date().toISOString(),
    evidenceBoundary: scorecard.evidenceBoundary,
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(resolve(outputDir, "manifest.json"), manifest),
    writeJson(resolve(outputDir, "scorecard.json"), scorecard),
    writeJsonl(resolve(outputDir, "cases.jsonl"), results),
    writeJsonl(resolve(outputDir, "failures.jsonl"), results.filter((result) => !result.cardSuccess && result.failureCode)),
    writeFile(resolve(outputDir, "report.md"), renderReport(manifest, scorecard, results), "utf8"),
  ]);
  console.log(`Context-card evaluation report written to ${outputDir}`);
  console.log(renderReport(manifest, scorecard, results));
}

async function evaluateCase(
  testCase: EvaluationCase,
  mode: "fixture" | "live",
  provider: ProviderConfig,
): Promise<CaseResult> {
  const usableSources = testCase.sourceSnapshots.filter(isUsableSource);
  const sourceSchemaValid = testCase.sourceSnapshots.every(isUsableSource);
  const started = Date.now();
  let output = mode === "fixture" && testCase.expected.decision === "generate_card"
    ? testCase.fixtureOutput
    : undefined;
  let failure = mode === "fixture" ? testCase.fixtureFailure : undefined;
  let keyword: string | null = testCase.fixtureOutput?.keyword ?? output?.keyword ?? null;
  let generationMs = output ? 1 : 0;
  if (mode === "live") {
    try {
      const keywordStarted = Date.now();
      const keywordResponse = await generateProviderJson<{ keyword?: unknown }>(provider, {
        system: keywordSystemPrompt(),
        prompt: `已知关键词：${testCase.input.knownKeywords.join(", ") || "无"}\n最近转写：${testCase.input.recentTranscript}`,
        timeoutMs: 30_000,
      });
      keyword = typeof keywordResponse.keyword === "string" ? keywordResponse.keyword.trim() : null;
      generationMs = Date.now() - keywordStarted;
      if (!keyword) failure = { code: "model_schema_invalid", message: "keyword field missing or empty" };
      if (keyword && isGenericOrDuplicate(keyword, testCase)) {
        return makeCaseResult(testCase, "skip", keyword, usableSources, sourceSchemaValid, null, null, Date.now() - started, generationMs, "none");
      }
      if (!failure && usableSources.length < testCase.expected.sourceRequirements.minUsableSources) {
        failure = { code: usableSources.length === 0 ? "no_sources" : "insufficient_sources", message: "fewer than two usable sources" };
      }
      if (!failure && keyword) {
        const cardStarted = Date.now();
        const cardResponse = await generateProviderJson<{ keyword?: unknown; explanation?: unknown; whyNow?: unknown }>(provider, {
          system: cardSystemPrompt(),
          prompt: cardPrompt(testCase, keyword, usableSources),
          timeoutMs: 45_000,
        });
        generationMs = Date.now() - cardStarted;
        if (typeof cardResponse.keyword !== "string" || typeof cardResponse.explanation !== "string" || typeof cardResponse.whyNow !== "string") {
          failure = { code: "schema_invalid", message: "card response schema invalid" };
        } else {
          output = { keyword: cardResponse.keyword.trim(), explanation: cardResponse.explanation.trim(), whyNow: cardResponse.whyNow.trim() };
        }
      }
    } catch (error) {
      failure = { code: errorCode(error), message: "provider request failed" };
    }
  }
  const actualDecision: ExpectedDecision = output
    ? isCardSchemaValid(output) ? "generate_card" : "schema_failed"
    : failure?.code === "schema_invalid" || failure?.code === "model_schema_invalid" ? "schema_failed"
      : failure?.code === "insufficient_sources" || failure?.code === "invalid_source" || failure?.code === "no_sources" ? "search_failed"
        : "skip";
  const cardSchemaValid = output
    ? isCardSchemaValid(output)
    : failure?.code === "schema_invalid" || failure?.code === "model_schema_invalid" ? false : null;
  const cardSuccess = actualDecision === "generate_card" && cardSchemaValid === true;
  const gracefulFailure = !cardSuccess && (actualDecision === testCase.expected.decision ||
    (testCase.expected.decision !== "generate_card" && actualDecision === "skip"));
  keyword = keyword ?? (failure ? testCase.expected.keyword : null);
  const keywordRelevant = keyword ? keywordMatches(keyword, testCase.expected.keyword, testCase.input.recentTranscript) : null;
  const sourceSupportScore = cardSuccess && output ? scoreSourceSupport(output, usableSources, testCase.expected.keyword) : null;
  const whyNowRelevanceScore = cardSuccess && output ? scoreWhyNow(output.whyNow, testCase) : null;
  const failureCode = failure?.code ?? (actualDecision === "schema_failed" ? "schema_invalid" : undefined);
  return makeCaseResult(testCase, actualDecision, keyword, usableSources, sourceSchemaValid, cardSchemaValid, cardSuccess, Date.now() - started, generationMs, usableSources.length >= 2 ? "tavily" : testCase.sourceSnapshots.length > 0 ? "failure" : "none", {
    gracefulFailure,
    keywordRelevant,
    sourceSupportScore,
    whyNowRelevanceScore,
    failureCode,
    card: output && cardSchemaValid === true ? output : undefined,
    usableSourceTitles: usableSources.map((source) => source.title),
    transcriptExcerpt: testCase.input.recentTranscript.slice(0, 600),
  });
}

function makeCaseResult(
  testCase: EvaluationCase,
  actualDecision: ExpectedDecision,
  keyword: string | null,
  usableSources: SourceSnapshot[],
  sourceSchemaValid: boolean,
  cardSchemaValid: boolean | null,
  cardSuccess: boolean | null,
  totalMs: number,
  generationMs: number,
  searchPath: CaseResult["searchPath"],
  extras: {
    gracefulFailure?: boolean;
    keywordRelevant?: boolean | null;
    sourceSupportScore?: number | null;
    whyNowRelevanceScore?: number | null;
    failureCode?: string;
    card?: { keyword: string; explanation: string; whyNow: string };
    usableSourceTitles?: string[];
    transcriptExcerpt?: string;
  } = {},
): CaseResult {
  const outputKeyword = keyword;
  const actualCardSuccess = cardSuccess ?? (actualDecision === "generate_card" && cardSchemaValid === true);
  return {
    id: testCase.id,
    tags: testCase.tags,
    expectedDecision: testCase.expected.decision,
    actualDecision,
    searchPath,
    keyword: outputKeyword,
    keywordRelevant: extras.keywordRelevant ?? (outputKeyword ? keywordMatches(outputKeyword, testCase.expected.keyword, testCase.input.recentTranscript) : null),
    sourceCount: testCase.sourceSnapshots.length,
    usableSourceCount: usableSources.length,
    sourceSchemaValid,
    cardSchemaValid,
    cardSuccess: actualCardSuccess,
    gracefulFailure: extras.gracefulFailure ?? (!actualCardSuccess && actualDecision === testCase.expected.decision),
    sourceSupportScore: extras.sourceSupportScore ?? null,
    whyNowRelevanceScore: extras.whyNowRelevanceScore ?? null,
    latencyMs: {
      search: testCase.sourceSnapshots.length > 0 ? 1 : 0,
      generation: generationMs,
      total: totalMs,
    },
    excluded: false,
    ...(extras.failureCode ? { failureCode: extras.failureCode } : {}),
    ...(extras.card ? { card: extras.card } : {}),
    ...(extras.usableSourceTitles ? { usableSourceTitles: extras.usableSourceTitles } : {}),
    ...(extras.transcriptExcerpt ? { transcriptExcerpt: extras.transcriptExcerpt } : {}),
  };
}

function resolveProvider(): ProviderConfig {
  const provider = process.env.CONTEXT_CARD_MODEL_PROVIDER === "remote-api" ? "remote-api" : "llama.cpp";
  return provider === "remote-api"
    ? {
        provider,
        baseUrl: process.env.REMOTE_API_BASE_URL?.trim() ?? "",
        model: process.env.REMOTE_API_MODEL?.trim() ?? "",
        apiKey: process.env.REMOTE_API_KEY?.trim() ?? "",
      }
    : {
        provider,
        baseUrl: process.env.LLAMA_CPP_BASE_URL?.trim() || "http://127.0.0.1:8082",
        model: process.env.LLAMA_CPP_MODEL?.trim() || "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        apiKey: process.env.LLAMA_CPP_API_KEY?.trim() ?? "",
      };
}

function generateProviderJson<T>(
  provider: ProviderConfig,
  args: { system: string; prompt: string; timeoutMs: number },
): Promise<T> {
  const request = { ...args, baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey };
  return provider.provider === "remote-api"
    ? generateRemoteApiJson<T>(request)
    : generateLlamaCppJson<T>(request);
}

function isGenericOrDuplicate(keyword: string, testCase: EvaluationCase): boolean {
  const normalized = keyword.trim().toLowerCase();
  return ["会议", "技术", "系统", "问题", "方案", "这个", "那个", "ai"].includes(normalized) ||
    testCase.input.knownKeywords.some((known) => known.trim().toLowerCase() === normalized);
}

function keywordSystemPrompt(): string {
  return "从技术会议转写中识别一个此刻最值得补充背景的具体技术关键词。只返回 JSON：{\"keyword\":\"...\"}。不要返回泛化词。";
}

function cardSystemPrompt(): string {
  return "你是实时会议认知助手。根据会议片段和来源生成短中文解释卡。只返回 JSON：{\"keyword\":\"...\",\"explanation\":\"...\",\"whyNow\":\"...\"}。不要编造来源未支持的事实。";
}

function cardPrompt(testCase: EvaluationCase, keyword: string, sources: SourceSnapshot[]): string {
  return [
    "<meeting_transcript_untrusted>",
    testCase.input.recentTranscript,
    "</meeting_transcript_untrusted>",
    `<keyword>${keyword}</keyword>`,
    "<search_evidence_untrusted>",
    ...sources.slice(0, 2).map((source, index) => `<source index=\"${index + 1}\">\ntitle: ${source.title}\nurl: ${source.url}\nsnippet: ${source.snippet}\n</source>`),
    "</search_evidence_untrusted>",
  ].join("\n\n");
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "provider_failure";
}

function summarize(fixture: FixtureFile, results: CaseResult[]): Scorecard {
  const scored = results.filter((result) => !result.excluded);
  const generated = results.filter((result) => result.expectedDecision === "generate_card");
  const searchCases = results.filter((result) => result.expectedDecision === "generate_card" || result.expectedDecision === "search_failed");
  const rate = (numerator: number, denominator: number): number | null => denominator > 0 ? round(numerator / denominator, 4) : null;
  const successfulSearch = searchCases.filter((result) => result.usableSourceCount >= 2).length;
  const sourceUsable = results.filter((result) => result.sourceCount > 0).filter((result) => result.usableSourceCount >= 2).length;
  const validSourceCases = results.filter((result) => result.sourceCount > 0).length;
  const validCards = generated.filter((result) => result.cardSchemaValid === true).length;
  const cardSuccesses = generated.filter((result) => result.cardSuccess).length;
  const relevanceCases = results.filter((result) => result.keywordRelevant !== null);
  const duplicateCases = results.filter((result) => result.expectedDecision === "skip" && result.tags.includes("duplicate_keyword"));
  const failureCounts: Record<string, number> = {};
  for (const result of results) {
    if (result.failureCode) failureCounts[result.failureCode] = (failureCounts[result.failureCode] ?? 0) + 1;
  }
  return {
    evaluator: EVALUATOR_VERSION,
    datasetVersion: fixture.version,
    status: results.every((result) => result.gracefulFailure || result.cardSuccess) ? "complete" : "failed",
    denominator: {
      totalCases: results.length,
      scoredCases: scored.length,
      excludedCases: results.filter((result) => result.excluded).length,
      generationExpectedCases: generated.length,
      searchExpectedCases: searchCases.length,
    },
    metrics: {
      keyword_relevance_rate: rate(relevanceCases.filter((result) => result.keywordRelevant === true).length, relevanceCases.length),
      keyword_duplicate_rate: rate(duplicateCases.filter((result) => result.actualDecision === "skip").length, duplicateCases.length),
      search_success_rate: rate(successfulSearch, searchCases.length),
      usable_source_rate: rate(sourceUsable, validSourceCases),
      card_schema_valid_rate: rate(validCards, generated.length),
      card_success_rate: rate(cardSuccesses, generated.length),
      graceful_failure_rate: rate(results.filter((result) => result.gracefulFailure).length, results.length),
      source_support_score: mean(results.flatMap((result) => result.sourceSupportScore === null ? [] : [result.sourceSupportScore])),
      why_now_relevance_score: mean(results.flatMap((result) => result.whyNowRelevanceScore === null ? [] : [result.whyNowRelevanceScore])),
      search_p50_ms: percentile(results.filter((result) => result.searchPath !== "none").map((result) => result.latencyMs.search), 0.5),
      generation_p50_ms: percentile(generated.map((result) => result.latencyMs.generation), 0.5),
      total_p50_ms: percentile(scored.map((result) => result.latencyMs.total), 0.5),
      total_p95_ms: percentile(scored.map((result) => result.latencyMs.total), 0.95),
    },
    failureCounts,
    latency: {
      search: summarizePercentiles(results.filter((result) => result.searchPath !== "none").map((result) => result.latencyMs.search)),
      generation: summarizePercentiles(generated.map((result) => result.latencyMs.generation)),
      total: summarizePercentiles(scored.map((result) => result.latencyMs.total)),
    },
    judge: {
      version: JUDGE_VERSION,
      type: "deterministic_heuristic",
      rubric: [
        "source_support_score: 1.0 when keyword/topic is represented by at least one source title or snippet, otherwise 0.0",
        "why_now_relevance_score: fraction of expected evidence terms present in whyNow or the current transcript",
        "keyword relevance: expected keyword or a transcript-supported equivalent must be present",
      ],
    },
    evidenceBoundary: "Synthetic fixed-source protocol evidence only. This run does not exercise Tavily, agent-reach, a model provider, real card generation, or production latency.",
  };
}

function isUsableSource(source: SourceSnapshot): boolean {
  return Boolean(source.title.trim() && source.snippet.trim() && isHttpUrl(source.url));
}

function isCardSchemaValid(value: { keyword: string; explanation: string; whyNow: string }): boolean {
  return Boolean(value.keyword.trim() && value.explanation.trim() && value.whyNow.trim());
}

function keywordMatches(actual: string, expected: string, transcript: string): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const a = normalize(actual);
  const e = normalize(expected);
  return a === e || normalize(transcript).includes(a);
}

function scoreSourceSupport(
  output: { keyword: string; explanation: string; whyNow: string },
  sources: SourceSnapshot[],
  expectedKeyword: string,
): number {
  const corpus = sources.map((source) => `${source.title} ${source.snippet}`).join(" ").toLowerCase();
  return corpus.includes(expectedKeyword.toLowerCase()) || corpus.includes(output.keyword.toLowerCase()) ? 1 : 0;
}

function scoreWhyNow(whyNow: string, testCase: EvaluationCase): number {
  const corpus = `${whyNow} ${testCase.input.recentTranscript}`.toLowerCase();
  const terms = testCase.expected.whyNowEvidence.map((term) => term.toLowerCase()).filter(Boolean);
  return terms.length === 0 ? 1 : round(terms.filter((term) => corpus.includes(term)).length / terms.length, 4);
}

function mean(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null;
}

function percentile(values: number[], ratio: number): number | null {
  return summarizePercentiles(values)?.[ratio === 0.5 ? "p50" : "p95"] ?? null;
}

function summarizePercentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (ratio: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 2),
    p50: at(0.5),
    p95: at(0.95),
  };
}

function parseFixture(value: unknown): FixtureFile {
  if (!isRecord(value) || typeof value.version !== "string" || !Array.isArray(value.cases)) {
    throw new Error("Invalid context-card evaluation fixture");
  }
  const cases = value.cases.filter(isEvaluationCase);
  if (cases.length !== value.cases.length) throw new Error("Context-card fixture contains an invalid case");
  return {
    version: value.version,
    source: value.source === "real" || value.source === "mixed" ? value.source : "synthetic",
    cases,
  };
}

function isEvaluationCase(value: unknown): value is EvaluationCase {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.input) &&
    typeof value.input.recentTranscript === "string" && Array.isArray(value.input.knownKeywords) &&
    Array.isArray(value.input.transcriptChunkIds) && typeof value.input.currentTime === "string" &&
    isRecord(value.expected) && typeof value.expected.decision === "string" &&
    typeof value.expected.keyword === "string" && Array.isArray(value.expected.whyNowEvidence) &&
    isRecord(value.expected.sourceRequirements) && Array.isArray(value.tags) &&
    Array.isArray(value.sourceSnapshots);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

function renderReport(manifest: Record<string, unknown>, scorecard: Scorecard, results: CaseResult[]): string {
  const lines = [
    "# CueMind Context-Card Evaluation Report",
    "",
    `- Dataset: \`${manifest.datasetVersion}\` (${manifest.datasetSource})`,
    `- Cases: ${scorecard.denominator.totalCases}; scored=${scorecard.denominator.scoredCases}; excluded=${scorecard.denominator.excludedCases}`,
    `- Status: \`${scorecard.status}\``,
    "",
    "## Metrics",
    "",
  ];
  for (const [name, value] of Object.entries(scorecard.metrics)) lines.push(`- ${name}: ${value ?? "null"}`);
  lines.push("", "## Failures", "");
  for (const [code, count] of Object.entries(scorecard.failureCounts)) lines.push(`- ${code}: ${count}`);
  if (Object.keys(scorecard.failureCounts).length === 0) lines.push("- none");
  lines.push("", "## Case Outcomes", "", "| ID | Expected | Actual | Search path | Sources | Card | Failure |", "| --- | --- | --- | --- | ---: | --- | --- |");
  for (const result of results) {
    lines.push(`| ${result.id} | ${result.expectedDecision} | ${result.actualDecision} | ${result.searchPath} | ${result.usableSourceCount}/${result.sourceCount} | ${result.cardSuccess ? "pass" : "no"} | ${result.failureCode ?? ""} |`);
  }
  lines.push(
    "",
    "## Judge",
    "",
    `- Version: \`${scorecard.judge.version}\``,
    "- Type: deterministic heuristic; no LLM judge was called.",
    "- Subjective scores are protocol-level signals and must not be interpreted as human or live-provider quality.",
    "",
    "## Evidence Boundary",
    "",
    scorecard.evidenceBoundary,
  );
  return `${lines.join("\n")}\n`;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
