# CueMind End-to-End Evaluation Report

- Status: `partial`
- Replay cases: 8; scored=8; excluded=0

## Evidence Layers

- Local-only provider evidence: {"provider":"llama.cpp","model":"/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf","baseUrl":"http://127.0.0.1:8082","status":"complete","requestedRuns":3,"completedRuns":3,"validJsonCount":3,"schemaValidCount":3,"excludedRunCount":0,"providerFailureCount":0,"invalidJsonCount":0,"schemaInvalidCount":0,"keywordRepeatConsistency":1,"latencyMs":{"count":3,"min":98,"max":402,"mean":199,"p50":98,"p95":98},"errorCodes":{}}
- Remote provider evidence: {"provider":"remote-api","model":"qwen3.8-max","baseUrl":"https://dashscope.aliyuncs.com","status":"complete","requestedRuns":3,"completedRuns":3,"validJsonCount":3,"schemaValidCount":3,"excludedRunCount":0,"providerFailureCount":0,"invalidJsonCount":0,"schemaInvalidCount":0,"keywordRepeatConsistency":1,"latencyMs":{"count":3,"min":8644,"max":12530,"mean":10624,"p50":10697,"p95":10697},"errorCodes":{}}
- Search evidence: fixed_snapshot_only
- Milvus evidence: {"status":"blocked_external_dependency","denominator":{"totalQueries":2,"completedQueries":0,"blockedQueries":2,"excludedQueries":0},"metrics":{"retrieval_success_rate":0,"relevant_result_rate":null,"fallback_required_rate":null,"retrieval_p50_ms":null,"retrieval_p95_ms":null},"contract":{"collectionName":"cuemind_knowledge_v1","embeddingModel":"BAAI/bge-m3","vectorDimension":1024,"schema":{"collectionName":"cuemind_knowledge_v1","embeddingModel":"BAAI/bge-m3","vectorDimension":1024,"fields":[{"name":"id","type":"VarChar","primaryKey":true},{"name":"text","type":"VarChar"},{"name":"embedding","type":"FloatVector","dimension":1024},{"name":"title","type":"VarChar"},{"name":"source_type","type":"VarChar"},{"name":"source_id","type":"VarChar"},{"name":"metadata","type":"JSON"}]},"fallbackBoundary":"Milvus is retrieval-only. Empty or insufficient results require the configured web search path; they must not be reported as successful knowledge evidence."},"evidenceBoundary":"Milvus was not configured. This report is an explicit blocked_external_dependency result and contains no fabricated retrieval result."}
- Replay evidence: pass

## Search Paths

- tavily: 4
- none: 2
- failure: 2

## Final States

- generate_card: 3
- skip: 2
- search_failed: 2
- schema_failed: 1

## Failures

- insufficient_sources: 1
- invalid_source: 1
- schema_invalid: 1

## Unverified Production Claims

- Windows dual-track audio capture
- long-video ASR stability
- live search quality and agent-reach availability
- Milvus ingestion completeness and embedding quality
- production card quality and release readiness

## Evidence Boundary

This release-gate summary combines the available evaluator artifacts. It does not convert synthetic fixed-source results, blocked Milvus status, or missing replay events into production readiness.
