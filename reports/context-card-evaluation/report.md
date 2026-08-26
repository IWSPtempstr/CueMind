# CueMind Context-Card Evaluation Report

- Dataset: `context-card-eval-v1` (synthetic)
- Cases: 8; scored=8; excluded=0
- Status: `complete`

## Metrics

- keyword_relevance_rate: 1
- keyword_duplicate_rate: 1
- search_success_rate: 0.6
- usable_source_rate: 0.6667
- card_schema_valid_rate: 1
- card_success_rate: 1
- graceful_failure_rate: 0.625
- source_support_score: 1
- why_now_relevance_score: 1
- search_p50_ms: 1
- generation_p50_ms: 1
- total_p50_ms: 0
- total_p95_ms: 0

## Failures

- insufficient_sources: 1
- invalid_source: 1
- schema_invalid: 1

## Case Outcomes

| ID | Expected | Actual | Search path | Sources | Card | Failure |
| --- | --- | --- | --- | ---: | --- | --- |
| cc-rag-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-kv-cache-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-milvus-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-duplicate-001 | skip | skip | none | 0/0 | no |  |
| cc-insufficient-sources-001 | search_failed | search_failed | failure | 1/1 | no | insufficient_sources |
| cc-invalid-source-001 | search_failed | search_failed | failure | 0/2 | no | invalid_source |
| cc-generic-001 | skip | skip | none | 0/0 | no |  |
| cc-schema-failure-001 | schema_failed | schema_failed | tavily | 2/2 | no | schema_invalid |

## Judge

- Version: `heuristic-judge-v1`
- Type: deterministic heuristic; no LLM judge was called.
- Subjective scores are protocol-level signals and must not be interpreted as human or live-provider quality.

## Evidence Boundary

Synthetic fixed-source protocol evidence only. This run does not exercise Tavily, agent-reach, Milvus, a model provider, real card generation, or production latency.
