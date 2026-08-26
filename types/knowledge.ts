export const CUEMIND_KNOWLEDGE_COLLECTION = "cuemind_knowledge_v1";
export const CUEMIND_EMBEDDING_MODEL = "text-embedding-v4";
export const CUEMIND_VECTOR_DIMENSION = 1024;

export interface KnowledgeDocument {
  id: string;
  text: string;
  embedding: number[];
  title: string;
  sourceType: "meeting" | "document" | "web";
  sourceId: string;
  metadata: Record<string, string | number | boolean>;
}

export interface KnowledgeRetrievalRequest {
  collectionName: string;
  vector: number[];
  topK: number;
  filter?: string;
  outputFields?: string[];
}

export interface KnowledgeRetrievalResult {
  id: string;
  score: number;
  text: string;
  title: string;
  sourceType: KnowledgeDocument["sourceType"];
  sourceId: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeRetrievalResponse {
  results: KnowledgeRetrievalResult[];
  fallbackRequired: boolean;
  fallbackReason?: "no_results" | "insufficient_results";
}
