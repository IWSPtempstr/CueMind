# CueMind Search, RAG, and Evaluation Implementation Plan

> **For agentic workers:** Execute this plan under `spec-first-harness` task-by-task. Each task declares its allowed files, concrete contract, validation commands, and progress-update expectations. Do not widen scope outside the task boundary.

**Goal:** Add Tavily-to-agent-reach search fallback, expand CueMind from provider-only keyword evaluation into search/card/end-to-end evaluation, and introduce a Milvus-backed local knowledge retrieval contract with reproducible evaluation artifacts.

**Architecture:** Keep CueMind's current `context-cards` route as the orchestration point, but split retrieval concerns into explicit adapters: direct web-search providers, a controlled `agent-reach` bridge fallback, and a local Milvus retrieval path for future knowledge lookups. Evaluation remains script-driven and artifact-first: each stage writes fixed manifests, scorecards, and human-readable reports without claiming evidence beyond the exercised layer.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, native `fetch`, local `llama.cpp`, external Tavily/Bing/SerpAPI APIs, local `agent-reach` CLI bridge, Milvus contract docs + Node evaluator scripts, JSONL/JSON reports.

---

## 0. Execution Rules

This plan is subordinate to:

- `/home/work/asr/CueMind/CLAUDE.md`
- `/home/work/asr/CueMind/docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`
- `/root/.codex/skills/spec-first-harness/SKILL.md`

Before every task:

```bash
cd /home/work/asr/CueMind
git status --short --branch
git diff --check
```

Preserve all pre-existing untracked paths:

- `dataset/`
- `docs/deployment/`
- `docs/plans/2026-08-26-cuemind-llama-provider-design.md`
- `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`
- `findings.md`
- `.env`

Git ownership stays with the main agent. Each task is implemented by a fresh subagent, reviewed by the main agent, then recorded in `progress.md` and `task_plan.md`.

## 1. Fixed Contracts

### 1.1 Search fallback contract

The effective search order is:

```text
configured web provider (tavily|bing|serpapi)
  -> optional agent-reach fallback
  -> search_failed
```

Rules:

- Fallback is allowed only when the configured provider is `tavily`.
- Fallback triggers on:
  - missing/empty Tavily key;
  - Tavily HTTP/network timeout failure;
  - Tavily usable-source count `< 2`.
- Fallback does not silently rewrite the provider identity; traces and reports must record both the primary provider and whether fallback was used.
- Fallback output must be normalized into the existing `SearchResult { title, url, snippet }` contract.
- No API key or raw shell command containing secrets may be written to logs, traces, or reports.

### 1.2 agent-reach bridge contract

Create a dedicated adapter that shells out to the locally installed `agent-reach` runtime. The adapter must:

- execute a fixed, read-only command path;
- enforce a timeout;
- capture stdout/stderr separately;
- parse deterministic JSON/YAML/text into `SearchResult[]`;
- return typed failure reasons:
  - `agent_reach_unavailable`
  - `agent_reach_timeout`
  - `agent_reach_invalid_output`
  - `agent_reach_no_usable_sources`
- never interpolate untrusted transcript text directly into shell syntax without argument separation.

The implementation may use `execFile`, not `exec`.

### 1.3 Card-level evaluation contract

Add an evaluator for full context-card generation with fixed inputs and fixed source snapshots. Each case must record:

- request metadata;
- selected provider;
- selected search path (`tavily`, `agent-reach`, `milvus`, `mixed`);
- keyword output;
- source list;
- card output or failure;
- per-stage latency;
- final state.

Metrics must include at minimum:

- `keyword_relevance_rate`
- `keyword_duplicate_rate`
- `search_success_rate`
- `usable_source_rate`
- `card_schema_valid_rate`
- `card_success_rate`
- `graceful_failure_rate`
- `source_support_score`
- `why_now_relevance_score`
- `search_p50_ms`
- `generation_p50_ms`
- `total_p50_ms`
- `total_p95_ms`

`source_support_score` and `why_now_relevance_score` may use LLM-as-a-judge, but the judge model, prompt, rubric, and version must be fixed in the manifest.

### 1.4 Milvus retrieval contract

The first iteration does not need full production persistence, but it must fix the contract:

- collection/schema name;
- embedding model identifier and vector dimension;
- inserted document shape;
- retrieval request shape;
- retrieval response shape;
- retrieval metadata filters;
- fallback behavior when Milvus yields insufficient evidence.

Milvus must be treated as a retrieval layer, not as a replacement for web search fallback.

### 1.5 Evaluation evidence boundary

Every generated report must explicitly distinguish:

- provider structured-output evidence;
- search retrieval evidence;
- card generation evidence;
- end-to-end replay evidence;
- externally unverified items.

No report may claim live search quality, Milvus quality, or production readiness without actually exercising that layer in the same run.

## 2. Phase Map

### Phase S0: freeze execution contract

Allowed files:

- `docs/plans/2026-08-26-cuemind-search-rag-evaluation-implementation-plan.md`
- `progress.md`
- `task_plan.md`

### Phase S1: Tavily fallback and retrieval adapters

Allowed files:

- `lib/search.ts`
- `lib/agent-reach-search.ts`
- `app/api/context-cards/route.ts`
- `hooks/useSettings.ts`
- `components/SettingsModal.tsx`
- `types/settings.ts`
- `scripts/test-context-card-route.ts`
- `docs/evaluation/provider-evaluation.md`
- `progress.md`
- `task_plan.md`

### Phase S2: search and card-level evaluation

Allowed files:

- `scripts/evaluate-model-providers.ts`
- `scripts/evaluate-context-cards.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `progress.md`
- `task_plan.md`

### Phase S3: Milvus contract and retrieval evaluation

Allowed files:

- `lib/milvus-retrieval.ts`
- `types/knowledge.ts`
- `scripts/evaluate-milvus-retrieval.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `README.md`
- `progress.md`
- `task_plan.md`

### Phase S4: end-to-end replay and release gate

Allowed files:

- `scripts/validate-replay.ts`
- `scripts/evaluate-end-to-end.ts`
- `reports/`
- `docs/evaluation/`
- `docs/desktop-mvp.md`
- `progress.md`
- `task_plan.md`

## 3. Task List

### Task 1: Define and implement Tavily -> agent-reach fallback

**Allowed files:**

- `lib/search.ts`
- `lib/agent-reach-search.ts`
- `app/api/context-cards/route.ts`
- `scripts/test-context-card-route.ts`
- `progress.md`
- `task_plan.md`

**Contract:**

- Tavily remains the primary provider.
- `agent-reach` is invoked only as a fallback path for Tavily.
- `context-cards` trace includes whether fallback was used.
- Existing Bing/SerpAPI behavior remains unchanged.

**Checks:**

```bash
TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

### Task 2: Wire search settings and runtime boundaries

**Allowed files:**

- `hooks/useSettings.ts`
- `hooks/useContextCards.ts`
- `components/SettingsModal.tsx`
- `types/settings.ts`
- `app/api/context-cards/route.ts`
- `lib/search.ts`
- `scripts/test-context-card-route.ts`
- `scripts/test-model-providers.ts`
- `progress.md`
- `task_plan.md`

**Contract:**

- Add explicit toggle(s) for enabling/disabling Tavily fallback.
- Prefer server-side `TAVILY_API_KEY` when present; browser `searchApiKey` remains a fallback.
- Store the browser search key using the existing secret-storage mechanism; do not persist it in
  general preference JSON.

**Checks:**

```bash
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

### Task 3: Add search-layer evaluator

**Allowed files:**

- `scripts/evaluate-context-cards.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `progress.md`
- `task_plan.md`

**Contract:**

- Fixed test cases with saved inputs and saved source snapshots.
- Report whether the source path was Tavily, agent-reach fallback, or failure.
- Distinguish no-source, invalid-source, timeout, and schema failure.

**Checks:**

```bash
TMPDIR=/tmp npx tsx scripts/evaluate-context-cards.ts
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

### Task 4: Add card-level evaluator and judge rubric

**Allowed files:**

- `scripts/evaluate-context-cards.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `progress.md`
- `task_plan.md`

**Contract:**

- Evaluate keyword, sources, explanation, and `whyNow`.
- Use a fixed judge spec for subjective dimensions.
- Record denominator, exclusions, failures, and prompt/judge version.

**Checks:**

```bash
TMPDIR=/tmp npx tsx scripts/evaluate-context-cards.ts
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

### Task 5: Add Milvus retrieval contract and evaluator

**Allowed files:**

- `lib/milvus-retrieval.ts`
- `types/knowledge.ts`
- `scripts/evaluate-milvus-retrieval.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `README.md`
- `progress.md`
- `task_plan.md`

**Contract:**

- Define Milvus collection, entity fields, retrieval request/response, and fallback boundary.
- Evaluate retrieval quality separately from card generation.
- If Milvus is not available in the environment, emit `blocked_external_dependency` instead of fabricating results.

**Checks:**

```bash
TMPDIR=/tmp npx tsx scripts/evaluate-milvus-retrieval.ts
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

### Task 6: Add end-to-end replay evaluator and release gate summary

**Allowed files:**

- `scripts/validate-replay.ts`
- `scripts/evaluate-end-to-end.ts`
- `reports/`
- `docs/evaluation/`
- `docs/desktop-mvp.md`
- `progress.md`
- `task_plan.md`

**Contract:**

- Replay evaluator must cover:
  - provider structured output;
  - search path selection;
  - card generation final state;
  - per-stage latency;
  - failure frequencies.
- Final report must separate:
  - local-only evidence
  - remote provider evidence
  - search evidence
  - Milvus evidence
  - unverified production claims

**Checks:**

```bash
TMPDIR=/tmp npx tsx scripts/validate-replay.ts /tmp/cuemind-runtime/cuemind-10min-replay.jsonl /tmp/cuemind-runtime/replay-report
TMPDIR=/tmp npx tsx scripts/evaluate-end-to-end.ts
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

## 4. Progress Recording Format

For each completed task, append one dated section to `progress.md` with:

- what changed;
- what was verified;
- what remains unverified;
- evidence boundary;
- cleanup audit items if the phase closed.

Update `task_plan.md` with:

- checklist completion state for Tasks 1-6;
- current unknowns;
- next active phase.

## 5. Release Gates

### Gate A: Search fallback

- Tavily success path works.
- Tavily failure path falls back to agent-reach.
- Trace records fallback.
- No secret leak.

### Gate B: Card evaluation

- Fixed-card evaluator runs.
- Card-level metrics are written.
- Reports include denominator, exclusions, and judge version.

### Gate C: Milvus retrieval

- Contract is documented and scriptable.
- Retrieval evaluation reports either complete evidence or explicit blocked status.

### Gate D: End-to-end replay

- Replay report shows search path, card result, latency, and failures.
- No report overclaims live production readiness.

## 6. Phase-End Cleanup Audit Requirements

At the end of the full 1-6 run, audit:

- `lib/agent-reach-search.ts`
- `scripts/evaluate-context-cards.ts`
- `scripts/evaluate-milvus-retrieval.ts`
- `scripts/evaluate-end-to-end.ts`
- `reports/` new artifacts
- `fixtures/` new inputs
- any temporary shell-bridge helpers

For each item, record:

1. file path
2. item type
3. current purpose
4. recommendation: keep / delete / review
5. short rationale

## 7. Verification Checklist

- [ ] Git baseline inspected before execution.
- [ ] Each task stays within its allowed files.
- [ ] Tavily fallback is explicit, not silent.
- [ ] `agent-reach` bridge uses argument-separated process execution.
- [ ] No API key appears in reports, traces, or committed docs.
- [ ] Card evaluation includes denominator, exclusions, and judge version.
- [ ] Milvus is treated as retrieval, not as web-search replacement.
- [ ] End-to-end replay distinguishes verified vs unverified claims.
- [ ] `npx tsc --noEmit`, `npm run lint`, `npm run build`, and task-specific scripts pass.
- [ ] `progress.md` and `task_plan.md` are updated after every task.

## 8. S5 Real Runtime Closure (2026-08-26)

Execute these operational tasks in order. External runtime state is evidence only after a bounded
health check and a reproducible evaluator run.

### S5-1: Start and verify local llama-server

Use the verified binary and Qwen GGUF outside the repository runtime workspace. Do not commit the
process, PID file, model, or logs. Verify `/health` and one JSON completion before recording the
provider as available.

### S5-2: Install and configure mcporter + Exa MCP

Install `mcporter` in the user/global tool environment, add the Exa MCP endpoint, then require
`agent-reach doctor --json` to report `exa_search.status = "ok"`. Verify one read-only semantic
search call and keep credentials out of repository artifacts.

### S5-3: Start and verify Milvus

Start Milvus Standalone with Docker. Verify the container and REST health endpoint, then configure
only non-secret connection metadata in `.env`.

### S5-4: Add real embedding and Milvus ingestion

Allowed files:

- `lib/knowledge-embeddings.ts`
- `scripts/ingest-milvus.ts`
- `scripts/evaluate-milvus-retrieval.ts`
- `fixtures/knowledge-documents-v1.json`
- `fixtures/milvus-retrieval-v1.json`
- `reports/`
- `docs/evaluation/milvus-retrieval.md`
- `progress.md`
- `task_plan.md`

Contract:

- Generate embeddings using one explicitly configured OpenAI-compatible embedding endpoint or local
  embedding runtime; record model and dimension in the manifest.
- Ingest versioned knowledge documents into `cuemind_knowledge_v1` with the fixed schema.
- Evaluate query vectors generated by the same embedding model. Deterministic placeholder vectors
  are not acceptable as real retrieval evidence.
- If the embedding endpoint or Milvus is unavailable, emit `blocked_external_dependency`.

### S5-5: Add trace-bearing ASR replay runner

Allowed files:

- `scripts/run-context-card-replay.ts`
- `scripts/validate-replay.ts`
- `scripts/evaluate-end-to-end.ts`
- `reports/`
- `docs/evaluation/`
- `progress.md`
- `task_plan.md`

Contract:

- Read the fixed ASR JSONL replay and submit bounded transcript windows to `/api/context-cards`.
- Persist one JSONL result per window containing request metadata, card/failure, trace, provider,
  search path, final state, and per-stage latency.
- Never persist API keys or complete unbounded transcript payloads in the trace artifact.
- The runner must support a live local endpoint and a deterministic mock mode for regression.

### S5-6: Re-run replay validation

Run `validate-replay` against the trace-bearing output and require non-zero provider/search/card
event counts before calling the replay gate closed. Then regenerate the end-to-end report and keep
all blocked external dependencies explicit.

### S5 execution status (2026-08-26)

| Step | Status | Evidence boundary |
| --- | --- | --- |
| S5-1 llama-server | complete | `/health` and one real structured completion succeeded at `127.0.0.1:8082`. |
| S5-2 mcporter + Exa | partial | Direct Exa MCP search succeeded; `agent-reach doctor` remains `warn`, not `ok`. |
| S5-3 Milvus | complete | v2 REST collection-list returned HTTP 200 with `code:0`; all standalone containers healthy. |
| S5-4 embedding/ingestion | blocked_external_dependency | Code is complete, but `EMBEDDING_API_BASE_URL` is empty; no vectors were inserted or evaluated. |
| S5-5 trace-bearing replay | complete | 20 live local-model windows produced trace-bearing JSONL; 10 cards generated. |
| S5-6 validation | complete/partial | Replay validator passed with non-zero provider/search/card counts; release summary remains partial because S5-2 and S5-4 gates are not closed. |
