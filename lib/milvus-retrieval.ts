import {
  CUEMIND_EMBEDDING_MODEL,
  CUEMIND_KNOWLEDGE_COLLECTION,
  CUEMIND_VECTOR_DIMENSION,
  type KnowledgeRetrievalRequest,
  type KnowledgeRetrievalResponse,
  type KnowledgeRetrievalResult,
} from "@/types/knowledge";

export type MilvusErrorCode = "milvus_unavailable" | "milvus_timeout" | "milvus_invalid_response";

export class MilvusRetrievalError extends Error {
  readonly code: MilvusErrorCode;
  constructor(code: MilvusErrorCode, message: string) {
    super(message);
    this.name = "MilvusRetrievalError";
    this.code = code;
  }
}

export interface MilvusRetrievalConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  collectionName?: string;
}

export const milvusSchema = {
  collectionName: CUEMIND_KNOWLEDGE_COLLECTION,
  embeddingModel: CUEMIND_EMBEDDING_MODEL,
  vectorDimension: CUEMIND_VECTOR_DIMENSION,
  fields: [
    { name: "id", type: "VarChar", primaryKey: true },
    { name: "text", type: "VarChar" },
    { name: "embedding", type: "FloatVector", dimension: CUEMIND_VECTOR_DIMENSION },
    { name: "title", type: "VarChar" },
    { name: "source_type", type: "VarChar" },
    { name: "source_id", type: "VarChar" },
    { name: "metadata", type: "JSON" },
  ],
} as const;

export async function retrieveKnowledge(
  config: MilvusRetrievalConfig,
  request: Omit<KnowledgeRetrievalRequest, "collectionName"> & { collectionName?: string },
): Promise<KnowledgeRetrievalResponse> {
  if (!config.baseUrl.trim()) {
    throw new MilvusRetrievalError("milvus_unavailable", "Milvus base URL is not configured");
  }
  if (request.vector.length !== CUEMIND_VECTOR_DIMENSION) {
    throw new MilvusRetrievalError("milvus_invalid_response", `Milvus query vector must have ${CUEMIND_VECTOR_DIMENSION} dimensions`);
  }
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 5_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v2/vectordb/entities/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token?.trim() ? { Authorization: `Bearer ${config.token.trim()}` } : {}),
      },
      body: JSON.stringify({
        collectionName: request.collectionName ?? config.collectionName ?? CUEMIND_KNOWLEDGE_COLLECTION,
        data: [request.vector],
        limit: Math.max(1, Math.min(20, Math.floor(request.topK))),
        filter: request.filter ?? "",
        outputFields: request.outputFields ?? ["id", "text", "title", "source_type", "source_id", "metadata"],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new MilvusRetrievalError("milvus_unavailable", `Milvus returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const results = normalizeResults(payload);
    return {
      results,
      fallbackRequired: results.length < 2,
      ...(results.length === 0 ? { fallbackReason: "no_results" as const } : results.length < 2 ? { fallbackReason: "insufficient_results" as const } : {}),
    };
  } catch (error) {
    if (error instanceof MilvusRetrievalError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new MilvusRetrievalError("milvus_timeout", `Milvus retrieval timed out after ${timeoutMs}ms`);
    }
    throw new MilvusRetrievalError("milvus_unavailable", "Milvus retrieval unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResults(payload: unknown): KnowledgeRetrievalResult[] {
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const id = stringValue(row.id);
    const text = stringValue(row.text);
    const title = stringValue(row.title);
    const sourceType = stringValue(row.source_type);
    const sourceId = stringValue(row.source_id);
    const score = typeof row.distance === "number" ? row.distance : typeof row.score === "number" ? row.score : null;
    if (!id || !text || !title || !sourceId || score === null || !isSourceType(sourceType)) return [];
    return [{
      id,
      score,
      text,
      title,
      sourceType,
      sourceId,
      metadata: isRecord(row.metadata) ? row.metadata : {},
    }];
  });
}

function isSourceType(value: string): value is KnowledgeRetrievalResult["sourceType"] {
  return value === "meeting" || value === "document" || value === "web";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
