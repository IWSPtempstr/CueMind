import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CUEMIND_EMBEDDING_MODEL,
  CUEMIND_VECTOR_DIMENSION,
} from "@/types/knowledge";

export type EmbeddingErrorCode =
  | "embedding_unavailable"
  | "embedding_timeout"
  | "embedding_invalid_response"
  | "embedding_dimension_mismatch";

export class KnowledgeEmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeEmbeddingError";
    this.code = code;
  }
}

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  dimension: number;
  timeoutMs?: number;
}

export interface EmbeddingResponse {
  model: string;
  dimension: number;
  embeddings: number[][];
}

const DEFAULT_ENV_PATH = resolve(process.cwd(), ".env");

/** Load only missing variables so an explicitly exported environment wins. */
export async function loadRepositoryEnv(path = DEFAULT_ENV_PATH): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (value) process.env[match[1]] = value;
  }
}

export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | null {
  const baseUrl = env.EMBEDDING_API_BASE_URL?.trim() ?? "";
  const model = env.EMBEDDING_API_MODEL?.trim() || CUEMIND_EMBEDDING_MODEL;
  if (!baseUrl) return null;
  const dimension = Number(env.EMBEDDING_VECTOR_DIMENSION ?? CUEMIND_VECTOR_DIMENSION);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new KnowledgeEmbeddingError("embedding_invalid_response", "EMBEDDING_VECTOR_DIMENSION must be a positive integer");
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey: env.EMBEDDING_API_KEY?.trim() || undefined,
    dimension,
    timeoutMs: parseTimeout(env.EMBEDDING_TIMEOUT_MS),
  };
}

export async function embedTexts(config: EmbeddingConfig, inputs: string[]): Promise<EmbeddingResponse> {
  if (inputs.length === 0) return { model: config.model, dimension: config.dimension, embeddings: [] };
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: inputs }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new KnowledgeEmbeddingError("embedding_unavailable", `Embedding endpoint returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    const embeddings = normalizeEmbeddings(payload, inputs.length);
    for (const vector of embeddings) {
      if (vector.length !== config.dimension) {
        throw new KnowledgeEmbeddingError(
          "embedding_dimension_mismatch",
          `Embedding endpoint returned dimension ${vector.length}; expected ${config.dimension}`,
        );
      }
    }
    const model = isRecord(payload) && typeof payload.model === "string" ? payload.model : config.model;
    return { model, dimension: config.dimension, embeddings };
  } catch (error) {
    if (error instanceof KnowledgeEmbeddingError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new KnowledgeEmbeddingError("embedding_timeout", `Embedding request timed out after ${timeoutMs}ms`);
    }
    throw new KnowledgeEmbeddingError("embedding_unavailable", "Embedding endpoint unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEmbeddings(payload: unknown, expectedCount: number): number[][] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (!data || data.length !== expectedCount) {
    throw new KnowledgeEmbeddingError("embedding_invalid_response", "Embedding response data count does not match input count");
  }
  const sorted = [...data].sort((left, right) => {
    const leftIndex = isRecord(left) && typeof left.index === "number" ? left.index : 0;
    const rightIndex = isRecord(right) && typeof right.index === "number" ? right.index : 0;
    return leftIndex - rightIndex;
  });
  return sorted.map((item) => {
    const vector = isRecord(item) && Array.isArray(item.embedding) ? item.embedding : null;
    if (!vector || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new KnowledgeEmbeddingError("embedding_invalid_response", "Embedding response contains an invalid vector");
    }
    return vector as number[];
  });
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value ?? 15_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
