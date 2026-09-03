# CueMind Context-Card Evaluation Report

- Dataset: `context-card-eval-v1` (synthetic)
- Cases: 8; scored=8; excluded=0
- Status: `complete`

## Metrics

- keyword_relevance_rate: 1
- keyword_duplicate_rate: 0
- search_success_rate: 0.6
- usable_source_rate: 0.6667
- card_schema_valid_rate: 1
- card_success_rate: 1
- graceful_failure_rate: 0.25
- source_support_score: 0.6667
- why_now_relevance_score: 1
- search_p50_ms: 1
- generation_p50_ms: 2422
- total_p50_ms: 1872
- total_p95_ms: 3080

## Failures

- insufficient_sources: 1
- no_sources: 1

## Case Outcomes

| ID | Expected | Actual | Search path | Sources | Card | Failure |
| --- | --- | --- | --- | ---: | --- | --- |
| cc-rag-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-kv-cache-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-milvus-001 | generate_card | generate_card | tavily | 2/2 | pass |  |
| cc-duplicate-001 | skip | generate_card | none | 0/0 | pass |  |
| cc-insufficient-sources-001 | search_failed | search_failed | failure | 1/1 | no | insufficient_sources |
| cc-invalid-source-001 | search_failed | search_failed | failure | 0/2 | no | no_sources |
| cc-generic-001 | skip | generate_card | none | 0/0 | pass |  |
| cc-schema-failure-001 | schema_failed | generate_card | tavily | 2/2 | pass |  |

## Judge

- Version: `heuristic-judge-v1`
- Type: deterministic heuristic; no LLM judge was called.
- Subjective scores are protocol-level signals and must not be interpreted as human or live-provider quality.

## Evidence Boundary

Synthetic fixed-source protocol evidence only. This run does not exercise Tavily, agent-reach, a model provider, real card generation, or production latency.
