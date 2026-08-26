# Milvus Retrieval Contract

CueMind treats Milvus as a local knowledge retrieval layer, not as a replacement for web-search
fallback. The retrieval contract is defined in `types/knowledge.ts` and implemented by
`lib/milvus-retrieval.ts`; S5-4 ingestion and embedding are implemented by
`scripts/ingest-milvus.ts` and `lib/knowledge-embeddings.ts`.

## Fixed schema

- Collection: `cuemind_knowledge_v1`
- Embedding model: `text-embedding-v4` (the configured endpoint must use this model for this fixture)
- Vector dimension: `1024`
- Fields: `id`, `text`, `embedding`, `title`, `source_type`, `source_id`, and `metadata`
- Source types: `meeting`, `document`, and `web`

Retrieval uses Milvus REST `POST /v2/vectordb/entities/search` with a vector, bounded `topK`, an
optional metadata filter, and explicit output fields. Results are normalized to a typed response.

Empty or fewer-than-two results return `fallbackRequired` with a reason. The caller may then use
the configured web-search path. A timeout, unavailable endpoint, or invalid response is a typed
failure and cannot be counted as successful knowledge evidence.

## Evaluation

The real embedding path is OpenAI-compatible and calls `POST /embeddings`. Configure it with local
environment variables; do not put keys in repository files or reports:

```env
EMBEDDING_API_BASE_URL=http://127.0.0.1:8000/v1
EMBEDDING_API_MODEL=text-embedding-v4
EMBEDDING_API_KEY=
EMBEDDING_VECTOR_DIMENSION=1024
EMBEDDING_TIMEOUT_MS=15000
MILVUS_BASE_URL=http://127.0.0.1:19530
MILVUS_TOKEN=
MILVUS_TIMEOUT_MS=5000
```

`ingest-milvus.ts` loads the repository-root `.env` by default, creates the fixed collection and
COSINE auto-index when absent, embeds the versioned documents, inserts them, and loads the
collection:

```bash
TMPDIR=/tmp npx tsx scripts/ingest-milvus.ts
TMPDIR=/tmp npx tsx scripts/evaluate-milvus-retrieval.ts
```

The evaluator loads the same `.env`, embeds each query with the same configured model, and then
searches Milvus. Without either endpoint, or when Milvus is unavailable, it writes
`blocked_external_dependency` and does not fabricate vectors or retrieval results. A completed
retrieval score requires `completedQueries > 0`; a blocked report is not a successful evaluation.
