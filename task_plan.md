# CueMind plan task tracking

## Priority Repairs

- [x] Priority 1: normalize legacy evaluator terminal states so fixed-snapshot `generate_card` cases count as `card_shown`.
- [x] Priority 2: split live runtime blocking dependency labels.
- [x] Priority 3: harden search source validation, Tavily transient-error fallback, and agent-reach typed failures.
- [ ] Priority 4: clarify Milvus contract verification versus retrieval quality.
- [x] Schema/provider step 1: add typed raw-response failure classification without changing card schema or route behavior.

## 2026-08-27 Minimal Demo Plan

- [x] Confirm scope: fixed 10-minute video demonstration.
- [x] Write approved design and explicit out-of-scope boundaries.
- [x] Write task-by-task implementation plan with fixed file boundaries and validation gates.
- [x] Execute Phase A-D from `docs/plans/2026-08-27-cuemind-demo-implementation-plan.md`.
  - [x] Task 1: freeze the 10-minute demonstration manifest.
  - [x] Task 2: define deterministic mixed-window behavior.
  - [x] Task 3: add explicit decision and terminal-state fields.
  - [x] Task 4: enforce conservative duplicate suppression.
  - [x] Task 5: make replay manifest-driven and ledger-complete.
  - [x] Task 6: render the bounded three-column demo state.
  - [x] Task 7: produce the end-to-end demo report.
  - [x] Task 8: final verification and phase-end cleanup audit.

Plan artifact: `docs/plans/2026-08-27-cuemind-demo-implementation-plan.md`
Current status: Tasks 1-8 complete; Priority 3 search-tool repair complete; Priority 4 pending. Human review is required for the blocked live gates.

Provider contract repair status: step 1 complete; real provider response capture remains unverified.

Task 7-8 closeout (2026-08-27):

- Task 7 report fields and evidence boundaries are implemented. The evaluator emits mock/fixed-snapshot evidence only: 8 candidates, 0 cards, card target `under_target`, and separate blocked dependencies `live_search_unavailable` and `live_context_card_runtime_unverified`. Existing generated reports were not regenerated within the Priority 2 file boundary.
- Task 8 final verification passed for the static checks and deterministic regressions recorded in `progress.md`. No factual correction was required in `docs/desktop-mvp.md`.
- The phase is complete as an evidence-safe implementation handoff, not as a live-search or production-readiness pass.

Provider/schema repair step 1 (2026-08-27):

- Added a stable `failureCode` contract for `http_error`, `timeout`, `network_error`,
  `invalid_json`, and `empty_response`, plus `stage` (`request` or `response`) and existing
  provider identity in `ModelProviderError` serialization.
- Preserved the existing `model_*` `code` values so the context-card route and existing callers
  remain compatible. No Markdown stripping, schema relaxation, prompt change, or raw response
  logging was introduced.
- TDD RED: provider tests failed on the first new HTTP classification assertion because the
  contract fields did not exist. GREEN: provider tests passed after the minimal implementation.
- Real Tavily, agent-reach, llama.cpp, and remote provider response capture was not performed in
  this step; the new classifications are covered by local deterministic HTTP fixtures only.

## Objective

Execute the P0-P3 specification in `docs/plans/2026-08-25-cuemind-detailed-implementation-plan.md` for CueMind's local-first realtime meeting cognition assistant. Each phase is reviewed, validated, and committed once before the next phase starts.

## Current Phase

- [x] P0: supplement execution specification and submission rules.
- [x] P0.1: freeze llama.cpp/provider migration baseline without changing production code.
- [x] P1-code: implement the local whisper.cpp ASR contract and serialized desktop transcription path.
- [x] P2: establish fixture replay validation and evidence-boundary reporting.
- [x] P3: close reproducible trace and prompt-injection boundary gaps from P2.
- [x] P1-runtime: run the real whisper.cpp small-model smoke test against the supplied video.

P0 is documentation-only. P1 code and the real whisper.cpp small-model smoke gate are complete. The remaining model/search/desktop items below are outside this ASR runtime gate and remain separately unverified.

## Phase Gates

| Phase | Scope | Required gate | Commit |
| --- | --- | --- | --- |
| P0 | Specs, status, and boundaries | `git diff --check`; `npm run lint`; `npm run build` | `docs: define CueMind execution spec` |
| P1 | Complete local replay-to-card chain | Lint/build, fake adapter regression, real ASR smoke test, fixed replay, Schema validation | `feat: complete CueMind local replay loop` |
| P2 | Fixed data and replay evaluation | JSONL validation, replay, repeated evaluation, report completeness | `test: add CueMind replay evaluation` |
| P3 | Evidence-driven optimization | P2 regression suite, unit/integration/E2E, safety and latency checks | `fix: improve CueMind evaluated failure cases` |

## Decisions

- Target: Chinese-first AI/software engineering meetings with mixed English technical terms.
- UX: automatic, low-volume cards; default card shows one source and expands for more.
- Runtime: current `whisper.cpp` small model and Qwen3-4B/`llama.cpp` first; remote model is visible fallback.
- Data: public meeting/video sources only; first release is evaluation-first, not training-first.
- Training order: trigger model first, end-to-end Agent later.
- Model scope: skip `whisper-large-zh-cv11` download and comparison testing in this round.
- P1 implementation scope delivered in this checkpoint: whisper.cpp JSON/text output parsing, WAV duration/RTF metrics, typed failure messages, timeout configuration, duplicate suppression, serialized desktop transcription queue, and a fake-whisper regression script.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| Git status failed from `/home/work/asr` | 1 | Re-ran from `/home/work/asr/CueMind`, the actual repository root. |

## Current Unknowns

- Local Qwen3-4B structured output, search provider behavior, Agent trace completeness, and real latency are not yet verified.
- End-to-end file replay, microphone input, Windows audio capture, remote fallback, and knowledge persistence are not yet verified.
- P2 currently validates fixture event integrity and supplied ASR latency metadata; it does not claim real ASR, local LLM, live search, or card-quality evidence.
- P3 implementation scope delivered in this checkpoint: context-card trace on normal and failure paths, bounded search retry events, and explicit untrusted-data delimiters for transcript/search evidence.
- The real smoke test covers one 30-second clip on CPU; long-video stability, Windows execution, and broader Chinese terminology quality remain unverified.
- P1-runtime implementation scope delivered in this checkpoint: source-built `whisper.cpp`, downloaded multilingual Small model, real adapter smoke runner, and reproducible media/model metadata capture.

## P0.1 Baseline Snapshot (2026-08-26)

- Repository: `/home/work/asr/CueMind`.
- Branch: `codex/local-realtime-meeting-copilot`.
- `HEAD`: `edf4912974c3ffbc4caebf8a9e13e9694d89d703` (`docs: clarify ASR runtime audit history`).
- Starting worktree state: no tracked-file modifications; pre-existing untracked paths were preserved:
  `dataset/`, `docs/deployment/`, `docs/plans/2026-08-26-cuemind-llama-provider-design.md`,
  `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`, and `findings.md`.
- Verified runtime artifacts:
  - `whisper.cpp 1.9.3-dev`; model `/home/work/asr/.runtime/models/ggml-small.bin`.
  - Qwen GGUF `/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`;
    SHA256 `2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`.
  - `/home/work/llama.cpp/build/bin/llama-server`;
    `0.3.0-dev (build 1, commit 1729ed5)`. The configured smoke-test port is `8080`;
    no llama-server process was running during this baseline capture.
- Existing 10-minute ASR replay: `321` transcript events; replay event validation passed.
  This is recorded from the existing project run evidence and was not re-run in this documentation-only task.
- Not verified in this baseline: live search provider behavior, remote OpenAI-compatible API behavior,
  local Qwen structured-output inference, and full desktop end-to-end card generation.
- P0.1 change boundary: only `task_plan.md` and `progress.md` may be modified.
- Git commit: intentionally not created; phase checkpoint remains pending user-requested commit policy.

## Llama Provider Migration (2026-08-26 plan)

- [x] P0.1: freeze llama.cpp/provider migration baseline (commit `b27307a`).
- [x] P1.1: add provider types and typed errors (`lib/model-provider.ts`, `types/settings.ts`, `scripts/test-model-providers.ts`).
- [x] P1.2: implement OpenAI-compatible JSON client in `lib/model-provider.ts`.
- [x] P1.3: add `lib/llama-cpp.ts` and `lib/remote-api.ts` wrappers.
- [x] P1.4: migrate settings and secret storage.
- [x] P1.5: replace settings UI labels and fields.
- [x] P1.6: route provider selection and failure states.
- [x] P1.7: remove Ollama runtime semantics.
- [x] P1.8: run real local provider smoke.
- [x] P2.1: extend replay evidence with provider metadata and failure counters.
- [x] P2.2: evaluate the local provider three times on one fixed ASR window.
- [x] P2.3: add the explicit-environment remote provider evaluation path.

### P2 provider evaluation checkpoint (2026-08-26)

- Replay reports now include `modelProvider`, `modelName`, host-safe remote `modelBaseUrl`, provider failure count, invalid JSON count, schema-invalid count, and fallback count.
- `scripts/evaluate-model-providers.ts` writes reproducible manifest, output/error/latency JSONL, scorecard, and Markdown report artifacts under `reports/provider-evaluation/`.
- Local GPU run used the first 62.6 seconds of the fixed 10-minute ASR transcript, 31 segments / 413 characters, and three repetitions against llama.cpp `0.3.0-dev` with Qwen3-4B Q4_K_M. All three outputs were valid JSON and schema-valid, keyword repeat consistency was `1.0`; the final artifact records the measured latency distribution. These are single fixed-window measurements, not a stable benchmark.
- Remote evaluation is `blocked_external_dependency` because `REMOTE_API_BASE_URL`, `REMOTE_API_MODEL`, and `REMOTE_API_KEY` were not supplied. No remote result was fabricated.
- Evidence boundary: this phase proves only replay/provider structured-output and request-latency behavior for the fixed window; it does not prove live search, card quality, or end-to-end readiness.

## Search, RAG, and Evaluation Expansion (2026-08-26 plan)

- [x] Task 1: define and implement Tavily -> agent-reach fallback.
- [x] Task 2: wire search settings and runtime boundaries.
- [x] Task 3: add search-layer evaluator.
- [x] Task 4: add card-level evaluator and judge rubric.
- [x] Task 5: add Milvus retrieval contract and evaluator.
- [x] Task 6: add end-to-end replay evaluator and release gate summary.

Current active phase: `S4 complete / release gate partial`

Current active task: `none; human review required for blocked external gates`

## S5 Real Runtime Closure (2026-08-26)

- [x] S5-1: start and verify local llama-server.
- [x] S5-2: install/configure mcporter + Exa MCP and verify agent-reach (direct Exa call works; doctor remains `warn`, accepted as the final evidence state).
- [x] S5-3: start and verify Milvus (containers healthy; v2 REST collection-list check returned `code:0`).
- [x] S5-4: add real embedding/ingestion and rerun Milvus evaluation (real insertion and retrieval complete).
- [x] S5-5: add trace-bearing ASR replay runner (20 live local-model windows written).
- [x] S5-6: rerun replay validation and end-to-end summary (validator pass; release summary remains partial).

Current active phase: `S5 runtime closure review`
Current active task: `none; runtime closure accepted`

S5-4 review summary:

- Scope respected: implementation changes are limited to the S5-4 allowed files; generated
  artifacts are under `reports/milvus-retrieval-evaluation/`. No production route or secret file
  was modified.
- `lib/knowledge-embeddings.ts` requires an explicit OpenAI-compatible embedding base URL, validates
  response count and vector dimension, and loads the repository-root `.env` without overwriting
  explicitly exported variables.
- Ingestion creates the fixed collection/schema and COSINE auto-index when needed, embeds the
  versioned fixture documents, inserts them, and loads the collection. Evaluation embeds query text
  with the same configured model before Milvus search; deterministic vectors were removed.
- Static checks pass: `TMPDIR=/tmp npx tsc --noEmit`, `npm run lint`, and `git diff --check`.
- Runtime checks now pass with real vectors: `insertedCount=4` and `completedQueries=2`.
  The collection was recreated to match the live `text-embedding-v4 / 1024` contract, and both
  ingestion and retrieval ran against the configured remote embedding endpoint.

S5-5/S5-6 review summary:

- `scripts/run-context-card-replay.ts` reads the fixed 10-minute ASR JSONL, bounds each request to
  a 30-second transcript window, supports `REPLAY_MODE=mock|live`, and writes one trace-bearing
  JSONL record per window without API keys or unbounded transcript payloads.
- The live local run completed 20 windows and wrote 10 generated cards. `validate-replay` passed
  with 20 provider structured-output events, 20 search events, 10 generated cards, and card
  latency P50/P95 of 2835/4155 ms.
- `evaluate-end-to-end.ts` now prefers the trace-bearing replay as its denominator. The final
  summary is `complete`: 20 replay cases, 10 generated cards, 10 skipped windows, while still
  distinguishing unverified production claims from verified local gates.

### S5 phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/run-context-card-replay.ts` | Evaluation runner | Replays bounded ASR windows through the context-card route and records traces | keep | Required S5 live/mock replay harness. |
| `scripts/ingest-milvus.ts` | Evaluation/operations script | Creates Milvus schema, embeds documents, inserts and loads entities | keep | Required ingestion gate; blocked output is evidence-safe. |
| `lib/knowledge-embeddings.ts` | Integration adapter | Calls the explicit OpenAI-compatible embedding endpoint | keep | Required real-vector boundary; no placeholder evidence. |
| `/tmp/cuemind-runtime/` | External runtime workspace | Stores servers, logs, replay outputs and validation reports | review | Retain for audit/reproduction; remove only when disk cleanup is desired. |
| `/tmp/cuemind-runtime/milvus/` | External Milvus compose workspace | Stores the downloaded compose file and service state | review | Keep while local Milvus is needed; do not commit runtime containers or images. |

Task 1 review summary:

- Scope respected: tracked code changes are limited to `app/api/context-cards/route.ts`,
  `lib/search.ts`, `lib/agent-reach-search.ts`, and `scripts/test-context-card-route.ts`;
  `progress.md` and `task_plan.md` are updated by the main agent for bookkeeping.
- Tavily remains the primary provider. Fallback is attempted only on the Tavily path for
  missing key, timeout/abort, HTTP failure, or fewer than two usable sources.
- Trace output now records the effective search provider and whether fallback was used.
- Bing and SerpAPI missing-key behavior remains unchanged.

Search/RAG current unknowns:

- The real `agent-reach` backend is not currently available on this machine: `agent-reach doctor --json`
  reports `exa_search.status = "off"` and `mcporter` is absent, so non-mocked fallback currently
  resolves to an explicit unavailable-path failure.
- Task 1 proves fallback wiring and deterministic error surfacing, but not live search quality.
- Search settings toggles, server-side `TAVILY_API_KEY` preference, card-level evaluation, Milvus
  retrieval, and end-to-end replay evidence remain pending in Tasks 2-6.

Task 2-6 review summary:

- Task 2 added the explicit fallback toggle, isolated browser search-key storage, and server-side
  `TAVILY_API_KEY` precedence. The route and settings regression scripts pass.
- Tasks 3-4 added `fixtures/context-card-evaluation-v1.json` and
  `scripts/evaluate-context-cards.ts`. The fixture run is complete for eight synthetic cases and
  records keyword, source, card, graceful-failure, judge, and latency metrics with denominators.
- Task 5 added the Milvus schema/retrieval contract and evaluator. With no `MILVUS_BASE_URL`, the
  evaluator correctly reports `blocked_external_dependency` for both fixed queries.
- Task 6 added `scripts/evaluate-end-to-end.ts` and extended replay metrics for provider structured
  output, search events/fallbacks, card final states, card failures, and card latency. The current
  release-gate summary is partial because search uses fixed snapshots and Milvus is blocked.

Final evidence boundary:

- Proven: fallback wiring, settings propagation, provider structured-output artifacts, deterministic
  fixed-source card protocol evaluation, Milvus request/schema contract, and evidence-safe report
  generation.
- Not proven: live Tavily quality, real agent-reach search, live search-to-card quality, Milvus
  ingestion/embedding quality, Windows capture, long-video stability, and production readiness.
