import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  embedTexts,
  KnowledgeEmbeddingError,
  loadRepositoryEnv,
  readEmbeddingConfig,
} from "@/lib/knowledge-embeddings";
import {
  retrieveKnowledge,
  MilvusRetrievalError,
  milvusSchema,
} from "@/lib/milvus-retrieval";
import {
  CUEMIND_EMBEDDING_MODEL,
  CUEMIND_KNOWLEDGE_COLLECTION,
  CUEMIND_VECTOR_DIMENSION,
} from "@/types/knowledge";

const DEFAULT_FIXTURE = "fixtures/milvus-retrieval-v1.json";
const DEFAULT_OUTPUT = "reports/milvus-retrieval-evaluation";

interface QueryCase {
  id: string;
  text: string;
  topK: number;
  expectedSourceType: "meeting" | "document" | "web";
  expectedTextTerm: string;
}

interface Fixture {
  version: string;
  collectionName: string;
  embeddingModel: string;
  vectorDimension: number;
  queries: QueryCase[];
}

async function main(): Promise<void> {
  await loadRepositoryEnv();
  const fixturePath = resolve(process.env.MILVUS_EVAL_FIXTURE ?? DEFAULT_FIXTURE);
  const outputDir = resolve(process.env.MILVUS_EVAL_OUTPUT_DIR ?? DEFAULT_OUTPUT);
  const fixture = parseFixture(JSON.parse(await readFile(fixturePath, "utf8")) as unknown);
  const baseUrl = process.env.MILVUS_BASE_URL?.trim() ?? "";
  const embedding = readEmbeddingConfig();
  const config = {
    baseUrl,
    token: process.env.MILVUS_TOKEN,
    timeoutMs: Number(process.env.MILVUS_TIMEOUT_MS ?? 5_000),
    collectionName: fixture.collectionName,
  };
  const embeddingBlockedReason = !embedding
    ? "EMBEDDING_API_BASE_URL is not configured"
    : embedding.model !== fixture.embeddingModel || embedding.dimension !== fixture.vectorDimension
      ? `Embedding contract mismatch: fixture=${fixture.embeddingModel}/${fixture.vectorDimension}, configured=${embedding.model}/${embedding.dimension}`
      : null;
  const configuredEmbedding = embedding;
  const cases: Array<Record<string, unknown>> = [];
  for (const query of fixture.queries) {
    const started = Date.now();
    if (!baseUrl || !configuredEmbedding || embeddingBlockedReason) {
      cases.push({
        id: query.id,
        status: "blocked_external_dependency",
        reason: !baseUrl ? "MILVUS_BASE_URL is not configured" : embeddingBlockedReason,
        latencyMs: null,
        results: [],
        fallbackRequired: null,
      });
      continue;
    }
    try {
      const embeddingResponse = await embedTexts(configuredEmbedding, [query.text]);
      const response = await retrieveKnowledge(config, {
        vector: embeddingResponse.embeddings[0],
        topK: query.topK,
        filter: `source_type == \"${query.expectedSourceType}\"`,
      });
      const relevant = response.results.some((result) => result.sourceType === query.expectedSourceType && result.text.includes(query.expectedTextTerm));
      cases.push({
        id: query.id,
        queryText: query.text,
        status: "complete",
        latencyMs: Date.now() - started,
        resultCount: response.results.length,
        fallbackRequired: response.fallbackRequired,
        fallbackReason: response.fallbackReason ?? null,
        relevant,
        results: response.results,
      });
    } catch (error) {
      const code = error instanceof MilvusRetrievalError ? error.code : "milvus_unavailable";
      const embeddingCode = error instanceof KnowledgeEmbeddingError ? error.code : undefined;
      const errorCode = embeddingCode ?? code;
      const blocked = ["milvus_unavailable", "milvus_timeout", "embedding_unavailable", "embedding_timeout"].includes(errorCode);
      cases.push({
        id: query.id,
        queryText: query.text,
        status: blocked ? "blocked_external_dependency" : "failed",
        latencyMs: Date.now() - started,
        errorCode,
        results: [],
        fallbackRequired: null,
      });
    }
  }
  const blocked = cases.filter((item) => item.status === "blocked_external_dependency").length;
  const completed = cases.filter((item) => item.status === "complete");
  const failed = cases.filter((item) => item.status === "failed").length;
  const relevant = completed.filter((item) => item.relevant === true).length;
  const scorecard = {
    status: blocked > 0 && failed === 0 ? "blocked_external_dependency" : failed > 0 ? "failed" : "complete",
    denominator: { totalQueries: cases.length, completedQueries: completed.length, blockedQueries: blocked, failedQueries: failed, excludedQueries: 0 },
    metrics: {
      retrieval_success_rate: cases.length > 0 ? completed.length / cases.length : null,
      relevant_result_rate: completed.length > 0 ? relevant / completed.length : null,
      fallback_required_rate: completed.length > 0 ? completed.filter((item) => item.fallbackRequired === true).length / completed.length : null,
      retrieval_p50_ms: percentile(completed.flatMap((item) => typeof item.latencyMs === "number" ? [item.latencyMs] : []), 0.5),
      retrieval_p95_ms: percentile(completed.flatMap((item) => typeof item.latencyMs === "number" ? [item.latencyMs] : []), 0.95),
    },
    contract: {
      collectionName: CUEMIND_KNOWLEDGE_COLLECTION,
      embeddingModel: CUEMIND_EMBEDDING_MODEL,
      vectorDimension: CUEMIND_VECTOR_DIMENSION,
      schema: milvusSchema,
      fallbackBoundary: "Milvus is retrieval-only. Empty or insufficient results require the configured web search path; they must not be reported as successful knowledge evidence.",
    },
    evidenceBoundary: baseUrl && embedding && !embeddingBlockedReason
      ? "Milvus retrieval evidence for query vectors generated by the configured OpenAI-compatible embedding endpoint; no claim about embedding quality, ingestion completeness, web fallback quality, or production readiness."
      : "Milvus or the explicitly configured embedding endpoint was not available. This report is an explicit blocked_external_dependency result and contains no fabricated retrieval result.",
  };
  const manifest = {
    evaluator: "milvus-retrieval-evaluator-v1",
    fixturePath,
    datasetVersion: fixture.version,
    baseUrl: redactBaseUrl(baseUrl),
    generatedAt: new Date().toISOString(),
    contract: scorecard.contract,
    evidenceBoundary: scorecard.evidenceBoundary,
  };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(resolve(outputDir, "manifest.json"), manifest),
    writeJson(resolve(outputDir, "scorecard.json"), scorecard),
    writeJsonl(resolve(outputDir, "cases.jsonl"), cases),
    writeFile(resolve(outputDir, "report.md"), renderReport(manifest, scorecard), "utf8"),
  ]);
  console.log(`Milvus retrieval evaluation report written to ${outputDir}`);
  console.log(renderReport(manifest, scorecard));
}

function parseFixture(value: unknown): Fixture {
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.collectionName !== "string" ||
    typeof value.embeddingModel !== "string" || typeof value.vectorDimension !== "number" || !Array.isArray(value.queries)) {
    throw new Error("Invalid Milvus evaluation fixture");
  }
  return value as unknown as Fixture;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function redactBaseUrl(value: string): string {
  if (!value) return "not-configured";
  try { return new URL(value).origin; } catch { return "invalid-url"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), "utf8");
}

function renderReport(manifest: Record<string, unknown>, scorecard: Record<string, unknown>): string {
  const metrics = scorecard.metrics as Record<string, unknown>;
  const denominator = scorecard.denominator as Record<string, unknown>;
  return [
    "# CueMind Milvus Retrieval Evaluation Report",
    "",
    `- Dataset: \`${manifest.datasetVersion}\``,
    `- Status: \`${scorecard.status}\``,
    `- Queries: ${denominator.totalQueries}; completed=${denominator.completedQueries}; blocked=${denominator.blockedQueries}`,
    "",
    "## Metrics",
    "",
    ...Object.entries(metrics).map(([key, value]) => `- ${key}: ${value ?? "null"}`),
    "",
    "## Evidence Boundary",
    "",
    String(scorecard.evidenceBoundary),
  ].join("\n") + "\n";
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
