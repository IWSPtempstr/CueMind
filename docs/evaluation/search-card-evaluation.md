# Search and Context-Card Evaluation

The fixed dataset is `fixtures/context-card-evaluation-v1.json`. It contains synthetic meeting
inputs and saved source snapshots, so the default run is deterministic and does not call Tavily,
agent-reach, Milvus, or a model provider.

## Reproduce the protocol run

```bash
TMPDIR=/tmp npx tsx scripts/evaluate-context-cards.ts
```

Artifacts are written to `reports/context-card-evaluation/`: manifest, scorecard, per-case JSONL,
failure JSONL, and a Markdown report. The scorecard records denominators, exclusions, failure codes,
latency, and the fixed judge specification.

## Evaluate a model against fixed source snapshots

Set `CONTEXT_CARD_EVAL_MODE=live`. This exercises the configured local or remote model while still
using saved source snapshots, so it is model-plus-fixed-retrieval evidence, not live web-search
quality evidence.

```bash
CONTEXT_CARD_EVAL_MODE=live \
  CONTEXT_CARD_MODEL_PROVIDER=llama.cpp \
  TMPDIR=/tmp npx tsx scripts/evaluate-context-cards.ts
```

Use `CONTEXT_CARD_MODEL_PROVIDER=remote-api` with `REMOTE_API_BASE_URL`, `REMOTE_API_MODEL`, and
`REMOTE_API_KEY` for the remote provider. API keys are request-only and are not written to reports.

The judge is `heuristic-judge-v1`: a deterministic protocol judge for keyword relevance, source
support, and `whyNow` overlap. It is not an LLM-as-a-judge and is not a substitute for human review.
