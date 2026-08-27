# Progress

## 2026-08-27 Priority Repairs

- Priority 1 completed: normalized legacy context-card evaluator decisions (`generate_card`, `skip`, `schema_failed`) into the current terminal-state vocabulary before aggregation. Added `scripts/test-end-to-end-evaluator.ts`; RED reproduced `cardCount=0` for a legacy generated card, and GREEN verified `card_shown=3` for the formal fixed-snapshot report without changing live-evidence boundaries.
- Priority 2 completed: split the end-to-end evaluator's combined live-runtime blocker into `live_search_unavailable` and `live_context_card_runtime_unverified`. Extended the evaluator regression with mock/fallback assertions; RED failed because the old composite label was still emitted, and GREEN passed after the minimal change. `searchEvidence` remains `fixed_snapshot_only`; no Milvus dependency was added to this repair.
- Priority 3 completed: hardened `searchWeb` and `searchWithAgentReach` source handling. RED reproduced acceptance of empty title/snippet metadata, duplicate URLs, and Tavily `fetch failed` without fallback. GREEN now requires trimmed non-empty title/snippet, HTTP(S) URLs normalized without fragments, and unique normalized URLs before counting sources; transient Tavily failures fall back while 4xx authentication/parameter failures do not. Mock and CLI paths preserve `agent_reach_invalid_output` and `agent_reach_no_usable_sources`. Added route/search regressions in `scripts/test-context-card-route.ts`.
- Priority 3 verification passed: context-card route, demo windowing, demo ledger, and end-to-end evaluator regressions; `npx tsc --noEmit`; `npm run lint`; and `git diff --check`. This repair does not verify remote source accessibility, semantic relevance, provider availability, agent-reach doctor readiness, live search quality, or production card quality. No Git commit was created. The current tool surface did not expose a subagent invocation handle for this repair, so implementation and verification were performed in the main execution context rather than falsely claiming independent subagent completion.

### 2026-08-27 Priority 3 search-tool cleanup audit

| Path | Item type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `lib/search.ts` | formal search adapter | Validates provider results and applies bounded Tavily-to-agent-reach fallback | keep | Production search contract and fail-closed source gate. |
| `lib/agent-reach-search.ts` | formal search adapter | Executes the fixed agent-reach bridge and preserves typed failures | keep | Required fallback adapter and diagnostic error boundary. |
| `scripts/test-context-card-route.ts` | official regression test | Covers source validation, fallback, authentication boundaries, and typed failures | keep | Deterministic contract coverage, not throwaway test code. |

## 2026-08-27 (minimal demo implementation plan)

- Read `docs/product/cuemind-grilling-decisions.md` and reconciled it with the current CueMind codebase.
- Confirmed the requested scope is the minimal fixed-video demonstration: 10-minute Chinese AI Agent technical content, local ASR, conservative card triggering, sourced cards, trace, replay, and latency evidence.
- Added `docs/plans/2026-08-27-cuemind-demo-design.md` with the approved architecture and explicit out-of-scope list.
- Added `docs/plans/2026-08-27-cuemind-demo-implementation-plan.md` with four phases and eight bounded tasks, including contracts, files, checks, review gates, and cleanup audits.
- Verified the selected existing video metadata used by the plan: duration `2865.581s`; SHA256 `7a777fa685b0c2d7de5cc4bf53a10e2920a76fec91c5cc4948ab4a651607def6`.
- Completed Phase A Task 1 files: `fixtures/demo-meeting/demo-manifest.json` and `fixtures/demo-meeting/README.md`. Verification passed with JSON parsing, SHA256 comparison, `git diff --check`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
- Phase A Task 1 review completed after a second-pass fix: added concrete windowing parameters, ASR model path/hash, and explicit local-fixture boundaries to satisfy reproducibility concerns.
- No runtime code was changed. `git diff --check` passed. Execution remains pending explicit selection of subagent-driven or inline implementation.

- Completed Phase A Task 2 with a fresh subagent and fixed TDD fixture: added `scripts/test-demo-windowing.ts` and the pure `buildDemoCandidateWindows` helper in `lib/replay.ts`. The helper emits stable core/context intervals, sentence-end/max-duration/end-of-input close reasons, and candidate-ID inputs without network, storage, UI, wall-clock, or random state.
- Task 2 review passed: exact windowing assertions, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`. The six fixed cases cover sentence-boundary closure, minimum accumulation, 2-second context overlap, 12-second maximum, end-of-input closure, and overlap-only chunk exclusion. Task 3 is now pending.

- Completed Phase B Task 3 with separate red-green subagents. The context-card route now validates bounded candidate metadata and intervals, carries `candidateId`, `datasetVersion`, `windowingVersion`, `decisionSource`, and one explicit terminal state in its trace, and returns `card_shown`, `model_skip`, `search_failed`, `model_failed`, `invalid_schema`, or `invalid_request` without trace secrets or full transcript content.
- Task 3 review passed: `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts`, `TMPDIR=/tmp npx tsx scripts/test-demo-windowing.ts`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`. The route regression covers success metadata, generic/duplicate keyword skips, search/provider/schema paths, and malformed candidate inputs. Task 4 is now pending.

- Completed Phase B Task 4 with separate red-green subagents. Duplicate suppression is conservative and deterministic: only trim/lowercase exact keyword matches against prior candidates become `suppressed_as_duplicate`, with `duplicateOfCandidateId` preserved in the trace; generic terms and old requests without candidate IDs retain `model_skip` behavior. No semantic similarity or learned suppression was added.
- The hook submits existing `{ candidateId, keyword }` pairs, excludes suppressed candidates from the rendered card list, and retains their terminal trace in the local failure/status record. Task 4 review passed: route and window regressions, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`. Task 5 is now pending.

- Completed Phase C Task 5 with fresh subagents. Replay now loads `fixtures/demo-meeting/demo-manifest.json` by default, builds deterministic candidate windows, derives SHA-256 candidate IDs from manifest/window inputs, sends bounded candidate metadata, and writes a redacted terminal trace envelope. `validateDemoLedger` enforces candidate/trace uniqueness, valid terminal states, and input/evaluable/excluded conservation; legacy `card_generated` is accepted for older replay artifacts while new `card_shown` is counted.
- Task 5 review passed: demo ledger test, context-card route regression, fixture replay validation, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`. The fixture report remains explicitly metadata-only and makes no live model/search/card-quality claim. Task 6 is now pending.

- Completed Phase C Task 6 with a fresh UI subagent after applying `impeccable` product-register constraints. `LiveSuggestions` now gives the first context card visual priority, bounds prior cards in a scroll region, and exposes source/failure/degradation text with `aria-live`; `LatencyPanel` surfaces latest total latency, card count, failure count, queue and degradation state without raw traces; the page enforces `min-w-0` across the desktop three-column layout while preserving mobile stacking.
- Task 6 review passed: context-card, windowing, and ledger regressions; `npx tsc --noEmit`; `npm run lint`; `npm run build`; `git diff --check`; and local dev smoke at `http://127.0.0.1:3100/` returned HTTP 200 with the CueMind shell. No `globals.css` change was needed. Task 7 is now pending.

- Completed Phase D Task 7 with a fresh task-specific implementation/review pass. `scripts/evaluate-end-to-end.ts` now reports the frozen manifest version, candidate denominator, card count, terminal-state counts, source-validity count, card target, latency percentiles, and blocked external dependencies. The report preserves the difference between deterministic fixed-snapshot/mock evidence and live runtime evidence.
- Task 7 evidence is intentionally partial: the evaluator's deterministic mock/fixed-snapshot run has manifest `demo-manifest-v1`, 8 candidates (8 evaluable, 0 excluded), 0 cards, source-valid cards `0`, and card target `3-5` with status `under_target`. Its `searchEvidence` is `fixed_snapshot_only`; `live_search_unavailable` and `live_context_card_runtime_unverified` remain blocked. Existing generated reports were not regenerated within the Priority 2 file boundary. This does not claim live search quality, live card generation, or production readiness.
- Task 7 review passed after correcting the evaluator boundary so mock replay cannot be classified as live evidence. The report uses `card_shown`/trace-aware counting for the new path and retains explicit unverified production claims.

- Completed Phase D Task 8 final verification and phase-end cleanup audit. No factual error requiring a `docs/desktop-mvp.md` change was found; its existing Windows, packaging, live-search, long-video, Milvus, and production-readiness limitations remain consistent with the observed evidence.
- Final verification results: `npx tsc --noEmit` passed; `npm run lint` passed; `npm run build` passed; `git diff --check` passed; `TMPDIR=/tmp npx tsx scripts/test-demo-windowing.ts` passed; `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts` passed; and `TMPDIR=/tmp npx tsx scripts/test-demo-ledger.ts` passed. Report-writing replay/evaluator commands were exercised in an isolated verification copy so the user-owned generated reports in this worktree were not overwritten.
- The current handoff is implementation-complete but evidence-partial. Mock-only/fixed-snapshot output must not be presented as live external search or live context-card runtime evidence; live search/runtime availability remains the blocking dependency, and the 3-5 card target is under target in the deterministic report.

### 2026-08-27 Phase D Task 8 cleanup audit

| Path | Item type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `app/api/context-cards/route.ts` | formal production code | Validates candidate metadata and emits sourced-card terminal traces | keep | In-scope business behavior and the API contract; never disposable. |
| `types/suggestions.ts` | formal type contract | Defines card metadata, source, failure, and terminal-state shapes | keep | Required shared interface for the live path and replay ledger. |
| `lib/replay.ts` | formal replay code | Builds deterministic candidate windows and ledger inputs | keep | Core reproducibility behavior, covered by regression tests. |
| `hooks/useContextCards.ts` | formal UI integration code | Submits candidates and retains suppressed/failure status | keep | Required user-visible behavior for duplicate and degraded states. |
| `components/LiveSuggestions.tsx` | formal UI code | Renders current card, bounded history, sources, and degradation | keep | The approved three-column demo workflow, not temporary UI. |
| `components/LatencyPanel.tsx` | formal UI code | Shows bounded latency and health metrics | keep | Required demo telemetry surface; no raw trace/debug output. |
| `app/page.tsx` | formal page composition | Wires the bounded desktop demo state | keep | Required application entry point for the implemented workflow. |
| `scripts/test-demo-windowing.ts` | official regression test | Checks deterministic interval and close-reason cases | keep | Formal contract test; must not be deleted as throwaway code. |
| `scripts/test-context-card-route.ts` | official regression test | Checks validation, terminal states, source failures, and duplicates | keep | Formal route regression coverage. |
| `scripts/test-demo-ledger.ts` | official regression test | Checks candidate IDs, terminal uniqueness, and conservation | keep | Formal ledger regression coverage. |
| `scripts/run-context-card-replay.ts` | evaluation runner | Produces bounded trace-bearing mock/live replay records | keep | Required reproducibility and evidence-generation tool; mock mode is explicitly labeled. |
| `scripts/validate-replay.ts` | evaluation validator | Validates JSONL integrity and candidate-ledger conservation | keep | Required audit gate for replay artifacts. |
| `scripts/evaluate-end-to-end.ts` | evaluation script | Aggregates provider, search, replay, and card evidence | keep | Required final report generator with evidence boundaries. |
| `fixtures/demo-meeting/demo-manifest.json` | frozen fixture manifest | Pins media, time range, ASR metadata, and windowing version | keep | Reproducibility anchor for the 10-minute demonstration. |
| `fixtures/demo-meeting/sample-events.jsonl` | user/demo fixture data | Supplies bounded transcript events for replay validation | keep | Fixture input required by the demo and protected from cleanup. |
| `dataset/` | user-provided dataset | Holds supplied meeting/video source material | keep | User data is explicitly protected and outside cleanup deletion. |
| `reports/end-to-end-evaluation/` | generated evidence reports | Stores scorecard, manifest, cases, and human-readable report | review | Keep as audit evidence, but review/regenerate when the source artifacts or evaluator version changes; do not treat mock output as live proof. |
| `reports/replay/` | generated replay report | Stores machine-readable replay validation evidence | keep | Needed to audit the candidate ledger and terminal-state conservation. |
| `reports/context-card-evaluation/` | generated evaluation report | Stores fixed-source card protocol results | review | Retain for reproducibility; review its fixed-snapshot status before using it for any release claim. |
| `reports/provider-evaluation/` | generated provider report | Stores local/remote structured-output evidence | review | Retain the recorded runs, but review runtime provenance and environment before reuse. |
| `reports/milvus-retrieval-evaluation/` | generated retrieval report | Stores retrieval contract/live dependency status | keep | Its blocked/partial boundary is useful evidence and must not be erased. |
| `/tmp/cuemind-runtime/` | external temporary runtime artifacts | Holds local servers, logs, and replay outputs | review | Outside the repository; retain only while needed for audit/reproduction, then clean by explicit operator choice. |
| `docs/desktop-mvp.md` | product evidence document | Records verified behavior and known platform/runtime gaps | keep | No factual error was found; it is the handoff boundary for unverified claims. |
| `progress.md` | project progress ledger | Records task results, evidence, and cleanup audits | keep | Required spec-first execution bookkeeping. |
| `task_plan.md` | project task ledger | Records task order, boundaries, and final status | keep | Required execution plan and review state. |

### 暂不纳入

- knowledge persistence（IndexedDB/SQLite）、provisional/active knowledge lifecycle、cross-meeting reuse。
- user feedback learning、context-level negative feedback、LLM Judge、人审抽样、冻结集质量门禁、online model training、automatic prompt/taxonomy changes。
- source conflict workflow/version rollback、background source freshness validation。
- full meeting-level remote authorization/privacy-policy UI。
- Milvus/embedding semantic retrieval in the realtime path。
- Windows hardware acceptance、helper compilation、installer packaging。
- production SLA、live search quality/agent-reach availability、long-video ASR stability、production card quality/readiness。

## 2026-08-25

- Inspected current repository and existing evaluation contract.
- Read relevant Agent evaluation sections from the supplied assessment document.
- Added the detailed plan at `docs/plans/2026-08-25-cuemind-detailed-implementation-plan.md`.
- Added explicit Agent metrics, thresholds, trace schema, test matrix and release gates.
- `git diff --check` passed.
- Confirmed no runtime code was modified; the new plan and internal planning notes are untracked documentation files.

## 2026-08-25 (Agent Reach and architecture decision)

- Read the upstream Agent Reach update/install instructions from the official repository.
- Installed Agent Reach `v1.5.0` in the user-level Python path and verified it from a fresh WSL login shell.
- Ran `agent-reach check-update`: latest version.
- Ran safe-mode install check and `agent-reach doctor`; no system-level changes were made.
- Confirmed the project plan supports three post-Ollama options; recommended `A` (local `llama.cpp` model retained), with `B` as a temporary remote fallback and `C` as an ASR-only slice.

## 2026-08-25 (P0 execution specification)

- Added the “执行规格与提交规则” section to the detailed implementation plan.
- Explicitly skipped `whisper-large-zh-cv11` download and comparison testing for this round.
- Fixed the current implementation order as P0 specification -> P1 complete local chain -> P2 replay evaluation -> P3 evidence-driven optimization.
- Defined per-phase task scope, allowed file boundaries, validation commands, and one submission requirement after each phase passes.
- Synchronized `task_plan.md` with the P0-P3 gates and recorded current unknowns.
- No runtime code was modified and no Git commit was created.
- The following remain unverified: local `whisper.cpp` execution and model quality, local Qwen3-4B structured output, real search behavior, Agent traces, end-to-end replay, latency, Windows audio capture, and remote fallback.

## 2026-08-25 (P1 local ASR contract)

- Updated `lib/local-asr.ts` to request whisper.cpp JSON/text artifacts, parse timestamped segments, calculate WAV duration and real-time factor, clean temporary output, and classify timeout/model/audio process failures.
- Updated `app/api/local-transcribe/route.ts` to return the expanded ASR result and validate an optional bounded timeout.
- Updated `hooks/useDesktopTranscript.ts` to serialize audio-chunk processing, suppress duplicate chunk IDs, and bound the pending queue to three items with explicit backpressure feedback.
- Added `scripts/test-local-asr.ts`, a fake-whisper regression check covering JSON segment parsing, text assembly, WAV duration, provider identity, and latency output.
- Verification passed: `npx tsc --noEmit`, `npm run lint`, `TMPDIR=/tmp npx tsx scripts/test-local-asr.ts`, `npm run build`, and `git diff --check`.
- At the time of the initial P1 checkpoint, real `whisper-cli`/model execution was not verified because no executable or model was found in the available WSL workspace. No `whisper-large-zh-cv11` artifact was downloaded.

## 2026-08-25 (P2 fixture replay evaluation)

- Added `scripts/validate-replay.ts` to validate JSONL desktop events and generate `manifest.json`, `scorecard.json`, and `report.md`.
- The replay evaluator checks invalid lines, duplicate IDs, transcript timing, empty text, covered duration, and ASR latency count/min/max/mean/P50/P95.
- Ran `TMPDIR=/tmp npx tsx scripts/validate-replay.ts fixtures/demo-meeting/sample-events.jsonl reports/replay`.
- Fixture result: 3 events, 3 transcript events, 19,000 ms covered duration, ASR latency count 3, P50 1,100 ms, P95 1,100 ms, all integrity checks passed.
- The generated report explicitly marks the result as fixture metadata evidence only; real whisper.cpp, local LLM, live search, context-card quality, and end-to-end latency remain blocked/unverified.

### P2 phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/validate-replay.ts` | Evaluation script | Validates JSONL fixture integrity and emits reproducible report artifacts | keep | It is the approved P2 replay evaluator, not throwaway code. |
| `reports/replay/manifest.json` | Generated report artifact | Captures fixture input and evidence boundary | keep | Required for reproducibility and auditability. |
| `reports/replay/scorecard.json` | Generated report artifact | Stores machine-readable checks and denominators | keep | Required for automated metric consumption. |
| `reports/replay/report.md` | Generated report artifact | Human-readable fixture evaluation result | keep | Required to distinguish passed fixture checks from blocked external evidence. |
| `scripts/test-local-asr.ts` | Regression script | Exercises the local ASR adapter with a fake whisper executable | keep | It is an official deterministic regression check for the adapter contract. |
| `dataset/` | User-provided data | Contains the supplied video and related artifacts | review | Not created by this phase; preserve and review separately before dataset freezing. |
| `findings.md` | Prior project notes | Records earlier architecture and research findings | keep | Pre-existing project documentation; not a temporary debug file. |

## 2026-08-25 (P3 trace and safety boundary)

- Updated `app/api/context-cards/route.ts` to return a typed trace for invalid input, model failure, skip, search failure, and successful card generation.
- The trace records `traceId`, model provider/name, input chunk IDs, ordered model/tool/generation events, retry count, final state, and total latency without embedding the full transcript.
- Search evidence and meeting transcript are now explicitly delimited as untrusted data in the card-generation prompt; source title/snippet content is bounded before insertion and cannot redefine system rules.
- Verification passed: `npx tsc --noEmit`, `npm run lint`, `npm run build`, `TMPDIR=/tmp npx tsx scripts/test-local-asr.ts`, `TMPDIR=/tmp npx tsx scripts/validate-replay.ts fixtures/demo-meeting/sample-events.jsonl reports/replay`, and `git diff --check`.
- This closes the reproducible API contract gap, but does not prove prompt-injection resistance against live providers or real model quality; those remain externally unverified.

## 2026-08-25 (final runtime audit)

- WSL network access recovered for GitHub and the Hugging Face mirror. `whisper.cpp` was built from source at version `1.9.3-dev` with the CPU/OpenMP backend.
- Downloaded only the multilingual `ggerganov/whisper.cpp` `ggml-small.bin` model through `hf-mirror.com`; no `whisper-large-zh-cv11` artifact was downloaded or tested.
- Model SHA256: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
- The supplied video duration is `2865.581s` (47m45.581s). Its first 30 seconds were converted to 16 kHz mono PCM WAV.
- Ran the project adapter against that WAV: `provider=local-whisper`, `audioDurationMs=30000`, `latencyMs=9758` on the final gate run, `realTimeFactor=0.3253`, `segmentCount=1`, `textLength=209`. An earlier repeat measured 10,265 ms / RTF 0.3422; these are single-run CPU smoke measurements, not a stable percentile benchmark.
- The output preserved Chinese and technical terms including `Agent Harness`, `Harness`, `Cloud Code`, `GitHub`, and `Learn Cloud Code`; this is a smoke result, not a general accuracy benchmark.
- `scripts/run-local-asr-smoke.ts` reproduces the adapter-level run and can emit a JSON report outside the repository.
- The real 30-second ASR runtime gate is closed. Long-video stability, Windows execution, broader terminology quality, local Qwen3-4B, live search, and full desktop end-to-end behavior remain unverified.

### P1-runtime phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/run-local-asr-smoke.ts` | Evaluation script | Runs the real project ASR adapter and emits a JSON smoke report | keep | Required to reproduce the runtime gate without committing model/audio binaries. |
| `/home/work/asr/.runtime/` | External runtime workspace | Stores source, build, model, and raw smoke outputs | review | Deliberately outside the Git repository; retain for local reproduction, do not commit large binaries. |
| `/tmp/cuemind-runtime/` | Temporary media/report workspace | Stores the 30-second derived WAV and adapter report | review | Useful for the current run; remove after the runtime evidence is archived if disk pressure matters. |
| `docs/desktop-mvp.md` | Product evidence log | Records WSL Small-model smoke and remaining Windows/long-video gaps | keep | Explicit evidence boundary for desktop delivery. |

### P3 phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `app/api/context-cards/route.ts` | Production route | Generates sourced cards and emits trace metadata | keep | Required production behavior and contract boundary. |
| `reports/replay/manifest.json` | Generated report artifact | Stores the stable fixture report manifest | keep | Existing committed evidence artifact; unchanged except regenerated timestamp was restored. |
| `dataset/` | User-provided data | Supplied video and related artifacts | review | Pre-existing and outside P3; preserve for separate dataset audit. |

## 2026-08-26 (P0.1 llama.cpp/provider migration baseline)

- Executed P0.1 from `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`.
- Git baseline: branch `codex/local-realtime-meeting-copilot`, `HEAD` `edf4912974c3ffbc4caebf8a9e13e9694d89d703`
  (`docs: clarify ASR runtime audit history`). The tracked worktree was clean before this task.
- Pre-existing untracked paths were preserved: `dataset/`, `docs/deployment/`,
  `docs/plans/2026-08-26-cuemind-llama-provider-design.md`,
  `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`, and `findings.md`.
- Verified ASR runtime artifact: `whisper.cpp 1.9.3-dev` with
  `/home/work/asr/.runtime/models/ggml-small.bin`.
- Verified Qwen runtime artifact:
  `/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
  SHA256 `2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`.
- Verified llama.cpp server artifact:
  `/home/work/llama.cpp/build/bin/llama-server`,
  `0.3.0-dev (build 1, commit 1729ed5)`. The configured smoke-test port is `8080`;
  no server process was active during this baseline capture.
- Existing 10-minute ASR replay evidence contains `321` transcript events and replay validation passed.
  This task records the prior result; it does not re-run the replay.
- Evidence boundary: live search and remote API are explicitly unverified. Local Qwen structured output,
  real provider latency, and full desktop end-to-end card generation are also unverified.
- Scope respected: only `task_plan.md` and `progress.md` were changed; no production code was changed;
  no Git commit was created.

### P0.1 verification record

- `git diff --check`: passed before and after the documentation update.
- `npm run lint`: passed (exit code 0).
- `npm run build`: passed (exit code 0; Next.js 15.5.15 production build).

## 2026-08-26 (P1.1 llama.cpp provider types and errors)

- Executed P1.1 from `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`.
- Created `lib/model-provider.ts` with `ModelProviderName = "llama.cpp" | "remote-api"`,
  the five typed `ModelProviderErrorCode` values, `ModelProviderError` with safe serialization,
  and `serializeModelProviderError` that never includes API keys or raw details.
- Extended `types/settings.ts` with the seven model-provider fields
  (`modelProvider`, `llamaCppBaseUrl`, `llamaCppModel`, `llamaCppApiKey`,
  `remoteApiBaseUrl`, `remoteApiModel`, `remoteApiApiKey`) as optional fields pending P1.4 migration.
- Added `scripts/test-model-providers.ts` covering provider-name validation, error-code
  validation, safe error serialization (no API key leak), error construction validation,
  and the settings contract.
- Verification passed: `TMPDIR=/tmp npx tsx scripts/test-model-providers.ts`, `npx tsc --noEmit`,
  and `git diff --check`.
- The existing `ollamaBaseUrl`/`ollamaModel` fields remain in `Settings` for now; they are
  migrated out and removed in P1.4. No runtime route or UI was changed in this task.

## 2026-08-26 (P1.2 OpenAI-compatible JSON client)

- Extended `lib/model-provider.ts` with the shared `generateOpenAiCompatibleJson<T>` client
  and the `JsonChatRequest` contract.
- The client normalizes a base URL that may or may not end in `/v1`, POSTs to
  `/v1/chat/completions`, sends `messages` + `temperature: 0` + `response_format` JSON object,
  sends `Authorization: Bearer` only for a non-empty key, aborts at `timeoutMs`, rejects
  non-2xx responses, and parses `choices[0].message.content` as JSON.
- Failures map to typed `ModelProviderError` codes: network failure -> `model_unreachable`,
  abort -> `model_timeout`, non-2xx (including 401/403) -> `model_http_error` with status,
  and missing/non-JSON assistant content -> `model_invalid_json`.
- `JsonChatRequest` carries `provider` so the shared client can attribute typed errors without
  a plugin registry; provider identity remains the wrappers' responsibility in P1.3.
- Extended `scripts/test-model-providers.ts` with a local mock HTTP server covering successful
  JSON, `/v1` suffix normalization, non-2xx, timeout, invalid assistant JSON, missing assistant
  content, no Authorization header for an empty key, and Bearer header for a non-empty key.
- Verification passed: `TMPDIR=/tmp npx tsx scripts/test-model-providers.ts`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build`, and `git diff --check`.

## 2026-08-26 (P1.3 provider wrappers)

- Created `lib/llama-cpp.ts` (`generateLlamaCppJson`) and `lib/remote-api.ts`
  (`generateRemoteApiJson`), both thin wrappers over the shared client.
- Each wrapper only supplies provider identity and rejects an empty base URL or model with
  a typed `model_unreachable` error before any network request.
- No plugin registry or strategy pattern was introduced; local and remote differ only in
  provider identity and configuration.
- Extended `scripts/test-model-providers.ts` with wrapper success, provider-identity on
  failure, empty-config rejection, and API-key non-leak checks.
- Verification passed: `TMPDIR=/tmp npx tsx scripts/test-model-providers.ts`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build`, and `git diff --check`.

## 2026-08-26 (P1.4 settings and secret storage migration)

- Made the seven model-provider fields required in `types/settings.ts`.
- Updated `hooks/useSettings.ts`:
  - default provider `llama.cpp`, `llamaCppBaseUrl` `http://127.0.0.1:8082`, and the verified
    Qwen GGUF path as `llamaCppModel`.
  - generalized the Groq secret-store pattern to three secrets (groq, llamaCpp, remoteApi) with
    distinct `cuemind_*` local/session keys and in-memory fallbacks.
  - `llamaCppApiKey` and `remoteApiApiKey` are now stored outside the preferences blob, and both
    plus the Groq key are stripped from `cuemind_settings` on persist.
  - one-time migration maps persisted non-default `ollamaBaseUrl`/`ollamaModel` into the
    llama.cpp fields and drops the legacy fields from persisted preferences.
  - existing Groq legacy-key migration behavior is unchanged.
- Extended `scripts/test-model-providers.ts` with default-settings and migration tests using a
  mock localStorage/sessionStorage.
- Verification passed: `TMPDIR=/tmp npx tsx scripts/test-model-providers.ts`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build`, and `git diff --check`.

## 2026-08-26 (P1.5 settings UI provider selection)

- Replaced the "实时认知卡片" Ollama fields in `components/SettingsModal.tsx` with a
  `模型 Provider` selector (`llama.cpp` / `远端 API`).
- Local fields (`llama-server 地址`, `本地模型路径`, `本地 API Key`) render only for `llama.cpp`;
  remote fields (`远端 Base URL`, `远端模型`, `远端 API Key`) render only for `remote-api`.
- Added an explicit note that remote requests send only minimum context (keyword and source
  summary), never full audio or the complete transcript.
- No visible "Ollama" label remains in the settings UI.
- Updated `hooks/useContextCards.ts` to send all seven model-provider fields plus the search
  provider/key to `/api/context-cards` (removed `ollamaBaseUrl`/`ollamaModel` from the payload).
- Verification passed: `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
- `rg -n "Ollama|ollama" components/SettingsModal.tsx hooks/useContextCards.ts` returns no matches.

## 2026-08-26 (P1.6 context-card route provider selection)

- Rewrote `app/api/context-cards/route.ts` to select exactly one provider from `modelProvider`.
- `resolveProvider` maps the selected provider to its base URL, model, and API key; `generateProviderJson`
  dispatches to `generateLlamaCppJson` or `generateRemoteApiJson` for both keyword and card JSON.
- The trace now carries `modelProvider`, `modelName`, and `modelBaseUrl` (no API key, no full transcript).
- Provider errors map to explicit reasons (`<provider> provider unreachable` / `timed out` /
  `HTTP <status>` / `returned invalid JSON` / `returned an invalid schema`); an invalid card schema now
  throws `ModelProviderError` with code `model_schema_invalid` instead of a bare string.
- No silent fallback: a provider failure returns `model_failed` for the selected provider and never calls
  the other provider.
- Added `scripts/test-context-card-route.ts` covering invalid request, local provider, remote provider,
  provider failure without silent fallback, invalid card schema, and search failure after keyword success.
  Search is intercepted offline via a `fetch` patch returning two deterministic sources.
- Verification passed: `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts`, `npm run lint`,
  `npx tsc --noEmit`, and `npm run build`.

## 2026-08-26 (P1.7 remove Ollama runtime semantics)

- Deleted `lib/ollama.ts` (the legacy `/api/generate` adapter).
- Removed the vestigial `ollamaBaseUrl`/`ollamaModel` fields from `types/settings.ts` and the one-time
  Ollama migration from `hooks/useSettings.ts`; the `llama.cpp`/`remote-api` fields now read directly
  from persisted preferences. This extends the P1.7 file boundary to `types/settings.ts` and
  `hooks/useSettings.ts` because the no-Ollama gate covers the `hooks` and `types` directories.
- Replaced the Ollama migration regression test in `scripts/test-model-providers.ts` with
  `testSettingsLoad`, which verifies direct loading of the provider fields and separate secret storage.
- Updated `README.md` and `docs/desktop-mvp.md` to describe local `llama.cpp` with an explicitly
  configured OpenAI-compatible remote API as an alternative.
- `rg -n "Ollama|ollama" app components hooks lib types README.md docs/desktop-mvp.md` returns no
  matches. Historical design/plan/deployment/evaluation docs under `docs/plans/`,
  `docs/deployment/`, and `docs/evaluation/` retain historical Ollama mentions per the plan's
  "historical notes" allowance and the preserve-`docs/deployment/` constraint.

## 2026-08-26 (P1.8 real local provider smoke)

- Created `scripts/run-local-model-smoke.ts`, which reads the first fixed 60-second window of a
  whisper.cpp raw JSON transcript (`transcription[].offsets.from < 60000`), joins the segment text,
  and asks the local provider for one keyword via `generateLlamaCppJson`.
- The report records `provider`, `model`, `baseUrl`, `inputWindowMs`, `inputChars`, `inputSegments`,
  `latencyMs`, `output`, `error`, and `evidenceBoundary`; it never records an API key, and it exits
  non-zero on an invalid transcript, non-JSON output, or a missing/empty keyword field.
- Ran the smoke against a live `llama-server` (`0.3.0-dev`) on port `8082` with the verified
  Qwen3-4B GGUF. Result: `provider=llama.cpp`, 31 segments / 413 chars from the first ~60 s,
  keyword `"Cloud Code"`, `error=null`. Keyword latency was 1,793 ms with CPU offload (`-ngl 0`) and
  510 ms with full GPU offload (`-ngl 99`) on the RTX 4060 Ti 8 GB (~4.5 GB VRAM). These are
  single-run smoke measurements, not a stable percentile benchmark; they are local-model
  structured-output evidence only — search, card assembly, and end-to-end card latency remain
  unverified.
- Verification passed: `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `git diff --check`.

## 2026-08-26 (P2 replay and provider evaluation)

- Extended `scripts/validate-replay.ts` with provider/model/base URL metadata and counters for provider failures, invalid JSON, schema-invalid outputs, and fallback events. Remote base URLs are reduced to origin when metadata is supplied through `MODEL_BASE_URL`.
- Added `scripts/evaluate-model-providers.ts`. It reads the same fixed first 60-second transcript window for every run, executes each provider independently, records valid JSON/schema validity/keyword consistency/latency denominators, and writes `manifest.json`, `outputs.jsonl`, `errors.jsonl`, `latency.jsonl`, `scorecard.json`, and `report.md`.
- Real local GPU evaluation completed against `llama-server` `0.3.0-dev (build 1, commit 1729ed5)` and Qwen3-4B Q4_K_M: 3/3 valid JSON, 3/3 schema-valid, keyword repeat consistency `1.0`; the final artifact records the measured latency distribution. These are single fixed-window structured-output measurements, not a stable production benchmark.
- Remote evaluation completed against an explicitly configured OpenAI-compatible endpoint on August 26, 2026. The final report records provider `remote-api`, model `qwen3.8-max`, endpoint origin `https://dashscope.aliyuncs.com`, 3/3 valid JSON, 3/3 schema-valid outputs, keyword repeat consistency `1.0`, and latency min `8644 ms`, mean `10624 ms`, P50 `10697 ms`, P95 `10697 ms`. No API key was written to artifacts.
- Added `docs/evaluation/provider-evaluation.md` documenting commands, artifacts, denominators, and evidence boundaries.
- P2 cleanup audit: keep `scripts/evaluate-model-providers.ts`, `scripts/validate-replay.ts`, `reports/provider-evaluation/`, and `docs/evaluation/provider-evaluation.md`; review generated reports before replacing them; preserve user-provided `dataset/` and existing deployment artifacts.

## 2026-08-26 (Task 1 search fallback)

- Added `lib/agent-reach-search.ts` as the dedicated Tavily fallback adapter. It exposes typed
  failure codes for unavailable runtime, timeout, invalid output, and no usable sources, and it
  keeps the shell boundary fixed instead of interpolating transcript text into a shell string.
- Updated `lib/search.ts` so `searchWeb()` returns `SearchExecution { provider, fallbackUsed, results }`.
  Tavily stays primary; fallback to `agent-reach` is attempted only for missing/empty Tavily key,
  timeout/abort, Tavily HTTP failure, or fewer than two usable sources. Bing and SerpAPI behavior
  remains unchanged.
- Updated `app/api/context-cards/route.ts` so trace events record the search provider and
  `fallbackUsed` flag on the search result path.
- Extended `scripts/test-context-card-route.ts` with deterministic fallback coverage:
  Tavily missing key -> mocked `agent-reach` success; Tavily missing key -> mocked `agent-reach`
  unavailable; Bing missing key still returns the original configuration error.
- Verified Task 1 with `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts`, `npx tsc --noEmit`,
  `npm run lint`, `npm run build`, and `git diff --check`.
- Evidence boundary: this task proves fallback routing, trace attribution, and deterministic failure
  surfacing. It does not prove live Tavily quality or real `agent-reach` search quality on this
  machine because `agent-reach` search backend is currently unavailable (`exa_search.status = "off"`
  and `mcporter` is absent).

## 2026-08-26 (Task 2 search settings and runtime boundary)

- Added `enableAgentReachFallback` to `Settings`, defaulting to enabled, and exposed it in the
  settings modal as an explicit Tavily fallback toggle.
- Moved browser search-key persistence into the existing local/session/memory secret-storage
  mechanism; `searchApiKey` is stripped from the general `cuemind_settings` JSON. Legacy embedded
  search keys are migrated once into local secret storage.
- Updated the context-card hook and route to carry the toggle. The route prefers server-side
  `TAVILY_API_KEY` for Tavily and falls back to the browser key only when the environment value is
  empty. Bing and SerpAPI continue using the browser-supplied key.
- Expanded deterministic route/settings regression coverage for disabled fallback, server-side Key
  precedence, secret loading, and the default toggle value.
- Verified with `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts`,
  `TMPDIR=/tmp npx tsx scripts/test-model-providers.ts`, `npx tsc --noEmit`, `npm run lint`,
  `npm run build`, and `git diff --check`.
- Evidence boundary: this proves configuration propagation and server-side Key selection in the
  route tests. It does not prove live Tavily or agent-reach availability/quality.

## 2026-08-26 (S5 real runtime closure started)

- Added S5-1 through S5-6 to the implementation plan with explicit runtime commands, file
  boundaries, health checks, evidence requirements, and blocked-dependency handling.
- The required order is local llama-server -> mcporter/Exa -> Milvus -> real embedding/ingestion ->
  trace-bearing replay -> replay validation.
- No S5 gate is marked complete before its bounded runtime evidence is captured.

## 2026-08-26 (S5-1 local llama-server)

- Started `/home/work/llama.cpp/build/bin/llama-server` with the verified Qwen3-4B GGUF at
  `http://127.0.0.1:8082` using GPU offload (`-ngl 99`). Runtime PID and logs remain outside the
  repository under `/tmp/cuemind-runtime/`.
- Verified `GET /health` returned `{"status":"ok"}`.
- Verified one real OpenAI-compatible JSON completion returned `{"keyword":"RAG"}` with
  `finish_reason="stop"`.
- S5-1 evidence boundary: local model service availability and one structured-output smoke only;
  this does not prove full context-card quality or replay coverage.

## 2026-08-26 (S5-2 mcporter and Exa MCP)

- Installed `mcporter` globally in the user tool environment and configured the Exa MCP endpoint in
  `/root/.mcporter/mcporter.json`; no repository files or secrets were changed.
- `agent-reach doctor --json` reports `exa_search.status = "warn"` because doctor intentionally does
  not start remote services for a live check. A direct read-only
  `mcporter call exa.web_search_exa` returned non-empty search results successfully.
- S5-2 evidence boundary: the Exa MCP backend is operational for direct calls; the doctor `warn`
  status must remain visible and is not rewritten to `ok`.

## 2026-08-26 (Tasks 3-4 search and card evaluation)

- Added the frozen synthetic dataset `fixtures/context-card-evaluation-v1.json` with eight stable
  cases covering generation, duplicate/generic skips, insufficient/invalid sources, and schema
  failure.
- Added `scripts/evaluate-context-cards.ts` with deterministic fixture mode and optional live model
  mode. Reports include keyword relevance, duplicate handling, source usability, card schema/success,
  graceful failure, source support, `whyNow` relevance, latency percentiles, denominator/exclusions,
  failure codes, prompt version, and judge version.
- Added `docs/evaluation/search-card-evaluation.md` documenting reproducibility and the boundary
  between fixed-source protocol evidence and live search evidence.
- Fixture verification passed: `TMPDIR=/tmp npx tsx scripts/evaluate-context-cards.ts`,
  `npx tsc --noEmit`, `npm run lint`, and `git diff --check`.
- Evidence boundary: the default report is synthetic fixed-source protocol evidence; it does not
  prove Tavily, agent-reach, Milvus, model quality, or production latency.

## 2026-08-26 (Task 5 Milvus retrieval contract)

- Added `types/knowledge.ts` with the fixed collection, embedding model, vector dimension,
  document shape, retrieval request/response, and insufficient-evidence fallback contract.
- Added `lib/milvus-retrieval.ts` using the Milvus REST search endpoint, bounded top-k, optional
  metadata filter, typed errors, and normalized results.
- Added `scripts/evaluate-milvus-retrieval.ts`, `fixtures/milvus-retrieval-v1.json`, and
  `docs/evaluation/milvus-retrieval.md`.
- Verified the unconfigured environment path: two queries reported `blocked_external_dependency`
  with no fabricated results. TypeScript, lint, and diff checks pass.
- Evidence boundary: Milvus schema/request behavior is implemented; live retrieval, ingestion
  completeness, embedding quality, and web fallback quality remain unverified.

## 2026-08-26 (Task 6 end-to-end replay and release summary)

- Extended `scripts/validate-replay.ts` to count provider structured-output events, search events and
  fallbacks, generated cards, card failures, and card latency from trace-bearing replay records.
- Added `scripts/evaluate-end-to-end.ts`, which combines provider, context-card, Milvus, and replay
  artifacts and separates local-only, remote, search, Milvus, and unverified production evidence.
- Updated `README.md` with the optional Milvus retrieval boundary and evidence-safe behavior.
- Verified the fixture replay command, end-to-end evaluator, TypeScript, lint, and diff checks.
- Current release summary is `partial` / `blocked_external_dependency` rather than a production pass:
  context-card evaluation is fixed-source mode, the checked-in replay fixture contains no card traces,
  and Milvus is not configured.

### Tasks 3-6 phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/evaluate-context-cards.ts` | Evaluation script | Runs fixed-source protocol and optional live model card evaluation | keep | Approved evaluator with reproducible artifacts and explicit evidence boundaries. |
| `fixtures/context-card-evaluation-v1.json` | Frozen fixture | Stable inputs/source snapshots/expected outcomes | keep | Required denominator and regression source for card evaluation. |
| `scripts/evaluate-milvus-retrieval.ts` | Evaluation script | Exercises Milvus retrieval or emits blocked status | keep | Required retrieval-layer gate; not throwaway code. |
| `lib/milvus-retrieval.ts` | Production adapter | Typed Milvus REST retrieval contract | keep | Approved knowledge retrieval boundary. |
| `scripts/evaluate-end-to-end.ts` | Evaluation script | Combines layer reports into release-gate summary | keep | Required final evidence aggregation. |
| `reports/context-card-evaluation/` | Generated artifacts | Fixture scorecard, cases, failures, and report | review | Regenerate when fixture or evaluator versions change. |
| `reports/milvus-retrieval-evaluation/` | Generated artifacts | Explicit blocked Milvus report | keep | Prevents blocked dependency from being mistaken for success. |
| `reports/end-to-end-evaluation/` | Generated artifacts | Partial release-gate summary | keep | Required to expose missing live/replay/Milvus evidence. |
| `/tmp/cuemind-runtime/replay-report-task6/` | Temporary report | Verification output for the sample replay | review | Outside repository; retain only if needed for local audit. |

## 2026-08-26 (S5-4 real embedding and Milvus ingestion/evaluation)

- Added `lib/knowledge-embeddings.ts` with an explicit OpenAI-compatible `/embeddings` client,
  response/dimension validation, timeout/error codes, and repository-root `.env` loading that does
  not overwrite explicitly exported environment variables.
- Added `fixtures/knowledge-documents-v1.json` and changed the Milvus query fixture to use real query
  text rather than deterministic seed vectors.
- Added `scripts/ingest-milvus.ts`, which validates the fixed contract, creates the
  `cuemind_knowledge_v1` schema and COSINE auto-index when absent, embeds documents, inserts rows,
  and loads the collection through Milvus REST.
- Updated `scripts/evaluate-milvus-retrieval.ts` to generate query embeddings through the same
  configured endpoint and to report unavailable embedding/Milvus dependencies as
  `blocked_external_dependency` without fabricated vectors or results.
- Verification: `TMPDIR=/tmp npx tsc --noEmit`, `npm run lint`, `git diff --check`, and both S5-4
  scripts execute. The scripts correctly wrote blocked reports because `MILVUS_BASE_URL` and
  `EMBEDDING_API_BASE_URL` are not configured and `127.0.0.1:19530` is currently unreachable.
- S5-4 implementation is complete, but the live gate remains blocked. No completed retrieval query
  or ingestion count is evidence until a reachable Milvus instance and explicit embedding endpoint
  are configured.

## 2026-08-26 (S5 runtime closure)

- S5-1 verified a persistent local `llama-server` at `127.0.0.1:8082`: `/health` returned `ok`
  and a real OpenAI-compatible structured completion succeeded. Runtime PID/logs remain under
  `/tmp/cuemind-runtime/`.
- S5-2 installed and configured `mcporter` with Exa MCP. A direct read-only Exa call returned
  non-empty results, and `agent-reach doctor --json` remains `warn`; that final state is accepted
  because the direct Exa probe is the real connectivity evidence.
- S5-3 started Milvus Standalone v2.6.22 with Docker. `milvus-standalone`, `milvus-etcd`, and
  `milvus-minio` are healthy; `POST http://127.0.0.1:19530/v2/vectordb/collections/list`
  returned HTTP 200 and `{"code":0,"data":[]}`. The image does not expose `/healthz` (HTTP 404),
  so the v2 REST check is the recorded health evidence. Non-secret Milvus metadata is in the
  ignored repository-root `.env`.
- S5-4 implementation is complete: explicit OpenAI-compatible embeddings, fixed 1024-dimension
  contract, Milvus collection/schema/index creation, document ingestion, and same-model query
  embedding. The live run inserted 4 documents and the evaluator completed 2/2 queries.
- S5-5 added `scripts/run-context-card-replay.ts`. The real local run processed 20 bounded 30-second
  windows from `/tmp/cuemind-runtime/cuemind-10min-replay.jsonl`, wrote one trace-bearing JSONL
  record per window, and generated 10 cards. Mock mode also passes the same envelope contract.
- S5-6 reran `validate-replay` on the trace-bearing output: status `pass`, provider structured
  output events `20`, search events `20`, generated cards `10`, card failures `0`, card latency
  P50/P95 `2835/4155 ms`. The end-to-end summary now uses the trace-bearing replay denominator:
  20 cases, 10 `card_generated`, 10 `skipped`, while still separating the unverified production
  claims from the verified local gates.

- Final verification after S5 changes passed: `npx tsc --noEmit`, `npm run lint`, `npm run build`,
  `git diff --check`, trace-bearing `validate-replay`, and end-to-end report regeneration. A scan
  of replay/report artifacts found no API-key patterns.

### S5 phase-end cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/run-context-card-replay.ts` | Evaluation runner | Runs bounded live/mock context-card replay and emits trace envelopes | keep | Required S5 replay evidence generator. |
| `scripts/ingest-milvus.ts` | Operations/evaluation script | Creates schema, embeds documents, inserts and loads Milvus data | keep | Required real-ingestion gate; blocked output is intentional. |
| `lib/knowledge-embeddings.ts` | Integration adapter | Calls the configured embedding endpoint and validates dimensions | keep | Prevents deterministic placeholder vectors from becoming evidence. |
| `/tmp/cuemind-runtime/` | External runtime workspace | Holds server processes, logs, and generated reports | review | Keep for reproducibility; clean up only when local audit artifacts are no longer needed. |
| `/tmp/cuemind-runtime/milvus/` | External compose workspace | Holds Milvus compose configuration and runtime state | review | Keep while Milvus is used locally; never commit container state or images. |

## 2026-08-27 (schema/provider repair step 1)

- Added the first typed raw-response failure contract in `lib/model-provider.ts` while preserving
  the existing `model_*` `code` values used by the context-card route.
- `failureCode` now distinguishes `http_error`, `timeout`, `network_error`, `invalid_json`, and
  `empty_response`; `stage` records whether the failure occurred during `request` or `response`.
- The OpenAI-compatible client now reads the response body as text before parsing so HTTP 200 with
  an empty body is distinguishable from non-empty invalid JSON. It does not strip Markdown, relax
  card schema validation, or log the raw response body.
- Extended `scripts/test-model-providers.ts` with deterministic local-server coverage for HTTP
  errors, timeout, network errors, empty responses, invalid response JSON, and invalid assistant
  JSON. Existing success behavior, provider wrappers, auth handling, and legacy error codes remain
  covered.
- TDD evidence: RED occurred at the first new HTTP classification assertion before implementation;
  GREEN completed after the minimal contract and parser changes.
- Verification passed: provider regression, context-card route regression, demo windowing, demo
  ledger, end-to-end evaluator regression, fixture replay validation, `npx tsc --noEmit` before
  and after build, `npm run lint`, `npm run build`, and `git diff --check`.
- Evidence boundary: no real Tavily, agent-reach, llama.cpp, or remote provider response was
  captured in this step. Real provider behavior and output quality remain unverified.

### Schema/provider repair step 1 cleanup audit

| Path | Type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `lib/model-provider.ts` | Production provider adapter | Carries compatible model errors and bounded raw-response classifications | keep | Required runtime contract; no raw response content is retained. |
| `scripts/test-model-providers.ts` | Official regression script | Exercises deterministic HTTP/parser failure boundaries | keep | Required TDD regression coverage, not throwaway test code. |
| `lib/llama-cpp.ts` | Provider wrapper | Preserves local provider identity and shared client behavior | keep | Existing production boundary; no temporary code added. |
| `lib/remote-api.ts` | Provider wrapper | Preserves remote provider identity and shared client behavior | keep | Existing production boundary; no temporary code added. |
