import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  embedTexts,
  KnowledgeEmbeddingError,
  loadRepositoryEnv,
  readEmbeddingConfig,
} from "@/lib/knowledge-embeddings";
import {
  CUEMIND_EMBEDDING_MODEL,
  CUEMIND_KNOWLEDGE_COLLECTION,
  CUEMIND_VECTOR_DIMENSION,
  type KnowledgeDocument,
} from "@/types/knowledge";

const DEFAULT_FIXTURE = "fixtures/knowledge-documents-v1.json";
const DEFAULT_OUTPUT = "reports/milvus-retrieval-evaluation";

interface Fixture {
  version: string;
  collectionName: string;
  embeddingModel: string;
  vectorDimension: number;
  documents: Array<Omit<KnowledgeDocument, "embedding">>;
}

interface MilvusConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
}

async function main(): Promise<void> {
  await loadRepositoryEnv();
  const fixturePath = resolve(process.env.MILVUS_DOCUMENT_FIXTURE ?? DEFAULT_FIXTURE);
  const outputDir = resolve(process.env.MILVUS_INGEST_OUTPUT_DIR ?? DEFAULT_OUTPUT);
  const fixture = parseFixture(JSON.parse(await readFile(fixturePath, "utf8")) as unknown);
  const baseUrl = process.env.MILVUS_BASE_URL?.trim() ?? "";
  const embedding = readEmbeddingConfig();
  const manifest = {
    evaluator: "milvus-ingestion-v1",
    fixturePath,
    datasetVersion: fixture.version,
    collectionName: fixture.collectionName,
    embeddingModel: embedding?.model ?? fixture.embeddingModel,
    vectorDimension: embedding?.dimension ?? fixture.vectorDimension,
    baseUrl: redactBaseUrl(baseUrl),
    generatedAt: new Date().toISOString(),
  };

  if (!baseUrl || !embedding) {
    await writeReport(outputDir, manifest, {
      status: "blocked_external_dependency",
      reason: !baseUrl ? "MILVUS_BASE_URL is not configured" : "EMBEDDING_API_BASE_URL is not configured",
      insertedCount: 0,
    });
    console.log(`Milvus ingestion blocked; report written to ${outputDir}`);
    return;
  }
  if (embedding.model !== fixture.embeddingModel || embedding.dimension !== fixture.vectorDimension) {
    await writeReport(outputDir, manifest, {
      status: "blocked_external_dependency",
      reason: `Embedding contract mismatch: fixture=${fixture.embeddingModel}/${fixture.vectorDimension}, configured=${embedding.model}/${embedding.dimension}`,
      insertedCount: 0,
    });
    console.log(`Milvus ingestion blocked by embedding contract; report written to ${outputDir}`);
    return;
  }

  const config: MilvusConfig = {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token: process.env.MILVUS_TOKEN?.trim() || undefined,
    timeoutMs: parseTimeout(process.env.MILVUS_TIMEOUT_MS),
  };
  try {
    await ensureCollection(config, fixture.collectionName);
    const vectors = await embedTexts(embedding, fixture.documents.map((document) => document.text));
    const rows = fixture.documents.map((document, index) => ({
      id: document.id,
      text: document.text,
      embedding: vectors.embeddings[index],
      title: document.title,
      source_type: document.sourceType,
      source_id: document.sourceId,
      metadata: document.metadata,
    }));
    const insert = await milvusRequest(config, "/v2/vectordb/entities/insert", {
      collectionName: fixture.collectionName,
      data: rows,
    });
    await milvusRequest(config, "/v2/vectordb/collections/load", { collectionName: fixture.collectionName });
    const result = {
      status: "complete",
      insertedCount: rows.length,
      milvusInsertResponse: insert.data ?? null,
      evidenceBoundary: "Documents were embedded by the configured OpenAI-compatible endpoint and inserted into Milvus; retrieval quality is measured separately by the evaluator.",
    };
    await writeReport(outputDir, manifest, result);
    console.log(`Inserted ${rows.length} knowledge documents into ${fixture.collectionName}`);
  } catch (error) {
    const reason = error instanceof KnowledgeEmbeddingError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Milvus ingestion failed";
    await writeReport(outputDir, manifest, { status: "blocked_external_dependency", reason, insertedCount: 0 });
    console.error(`Milvus ingestion blocked: ${reason}`);
    process.exitCode = 2;
  }
}

async function ensureCollection(config: MilvusConfig, collectionName: string): Promise<void> {
  const listed = await milvusRequest(config, "/v2/vectordb/collections/list", {});
  const names = Array.isArray(listed.data) ? listed.data.filter((item): item is string => typeof item === "string") : [];
  if (names.includes(collectionName)) {
    const described = await milvusRequest(config, "/v2/vectordb/collections/describe", { collectionName });
    const existingDimension = readCollectionDimension(described.data);
    if (existingDimension === CUEMIND_VECTOR_DIMENSION) return;
    await milvusRequest(config, "/v2/vectordb/collections/drop", { collectionName });
  }
  await milvusRequest(config, "/v2/vectordb/collections/create", {
    collectionName,
    schema: {
      autoID: false,
      enableDynamicField: false,
      fields: [
        { fieldName: "id", dataType: "VarChar", isPrimary: true, elementTypeParams: { max_length: "128" } },
        { fieldName: "text", dataType: "VarChar", elementTypeParams: { max_length: "8192" } },
        { fieldName: "embedding", dataType: "FloatVector", elementTypeParams: { dim: String(CUEMIND_VECTOR_DIMENSION) } },
        { fieldName: "title", dataType: "VarChar", elementTypeParams: { max_length: "512" } },
        { fieldName: "source_type", dataType: "VarChar", elementTypeParams: { max_length: "32" } },
        { fieldName: "source_id", dataType: "VarChar", elementTypeParams: { max_length: "512" } },
        { fieldName: "metadata", dataType: "JSON" },
      ],
    },
    indexParams: [{ fieldName: "embedding", indexName: "embedding_autoindex", metricType: "COSINE", indexType: "AUTOINDEX" }],
  });
}

function readCollectionDimension(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.fields)) return null;
  for (const field of value.fields) {
    if (!isRecord(field) || field.name !== "embedding" || !Array.isArray(field.params)) continue;
    for (const param of field.params) {
      if (isRecord(param) && param.key === "dim" && typeof param.value === "string") {
        const parsed = Number(param.value);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }
  }
  return null;
}

async function milvusRequest(config: MilvusConfig, path: string, body: unknown): Promise<{ data?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Milvus ${path} returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || (typeof payload.code === "number" && payload.code !== 0)) {
      throw new Error(`Milvus ${path} returned an invalid or failed response`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function parseFixture(value: unknown): Fixture {
  if (!isRecord(value) || typeof value.version !== "string" || value.collectionName !== CUEMIND_KNOWLEDGE_COLLECTION ||
    value.embeddingModel !== CUEMIND_EMBEDDING_MODEL || value.vectorDimension !== CUEMIND_VECTOR_DIMENSION || !Array.isArray(value.documents)) {
    throw new Error("Invalid knowledge document fixture");
  }
  return value as unknown as Fixture;
}

async function writeReport(outputDir: string, manifest: Record<string, unknown>, result: Record<string, unknown>): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(resolve(outputDir, "ingestion-manifest.json"), manifest),
    writeJson(resolve(outputDir, "ingestion-result.json"), result),
  ]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value ?? 5_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}

function redactBaseUrl(value: string): string {
  if (!value) return "not-configured";
  try { return new URL(value).origin; } catch { return "invalid-url"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
