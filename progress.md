# Progress

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
