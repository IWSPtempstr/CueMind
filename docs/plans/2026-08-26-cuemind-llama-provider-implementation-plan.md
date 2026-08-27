# CueMind Llama Provider Implementation Plan

> **For agentic workers:** Execute this plan task-by-task under `spec-first-harness`. Each task has a fixed file boundary, required checks, review gate, and progress update. Do not use Ollama.

**Goal:** Replace CueMind's Ollama model path with explicit `llama.cpp` and OpenAI-compatible `remote-api` providers, while preserving structured card generation, traceability, transparent provider identity, and replayability.

**Architecture:** Both providers call `/v1/chat/completions` through a shared small client contract. The local provider points to `llama-server`; the remote provider uses an explicitly configured base URL, model, and API key. The context-card route selects exactly one provider from settings, validates every JSON response locally, and never silently switches providers.

**Tech Stack:** Next.js App Router, React 19, TypeScript, native `fetch`, `llama.cpp/llama-server`, OpenAI-compatible chat completions, JSONL replay, existing CueMind search and trace modules.

---

## 0. Execution Rules

This plan is subordinate to:

- `/home/work/asr/CueMind/docs/plans/2026-08-25-cuemind-detailed-implementation-plan.md`
- `/home/work/asr/CueMind/docs/plans/2026-08-26-cuemind-llama-provider-design.md`
- `/root/.codex/skills/spec-first-harness/SKILL.md`

The active branch is `codex/local-realtime-meeting-copilot`. Before each phase:

```bash
cd /home/work/asr/CueMind
git status --short --branch
git diff --check
```

User-provided or unrelated untracked paths must be preserved:

- `dataset/`
- `findings.md`
- `docs/deployment/`

The main agent owns Git commits. Each task is implemented by a fresh subagent inside the task's declared file boundary, then reviewed by the main agent. A phase may be committed only after all task checks pass. If the same task fails after three repair rounds, stop and report the blocker.

## 1. Fixed Contracts

### 1.1 Provider names

```ts
export type ModelProviderName = "llama.cpp" | "remote-api";
```

The string `"ollama"` must not appear in new runtime settings, UI labels, route payloads, trace provider values, or new tests.

### 1.2 Settings contract

Extend `Settings` with:

```ts
modelProvider: "llama.cpp" | "remote-api";
llamaCppBaseUrl: string;
llamaCppModel: string;
llamaCppApiKey: string;
remoteApiBaseUrl: string;
remoteApiModel: string;
remoteApiApiKey: string;
```

Defaults:

```ts
modelProvider: "llama.cpp";
llamaCppBaseUrl: "http://127.0.0.1:8082";
llamaCppModel: "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
llamaCppApiKey: "";
remoteApiBaseUrl: "";
remoteApiModel: "";
remoteApiApiKey: "";
```

The API key must not be persisted in the general preferences JSON. Follow the existing secret-storage pattern used for the Groq key, using a separate local/session/memory key if the settings contract exposes storage selection.

### 1.3 Provider request contract

Create a focused JSON chat client contract:

```ts
export interface JsonChatRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  system: string;
  prompt: string;
  timeoutMs: number;
}

export async function generateOpenAiCompatibleJson<T>(
  request: JsonChatRequest,
): Promise<T>;
```

The function must:

- normalize a base URL that may or may not already end in `/v1`;
- POST to `/v1/chat/completions`;
- send `messages`, `temperature: 0`, and `response_format: { type: "json_object" }`;
- send `Authorization: Bearer <apiKey>` only when the key is non-empty;
- abort at `timeoutMs`;
- reject non-2xx responses;
- reject missing assistant content;
- parse assistant content as JSON;
- expose typed error categories for unreachable, timeout, invalid JSON, schema-invalid, and HTTP/auth failures.

Provider-specific modules may wrap this function only to supply provider identity and defaults. Do not create a generic plugin registry.

### 1.4 Context-card route contract

The request settings must contain:

```ts
{
  modelProvider: "llama.cpp" | "remote-api";
  llamaCppBaseUrl: string;
  llamaCppModel: string;
  llamaCppApiKey: string;
  remoteApiBaseUrl: string;
  remoteApiModel: string;
  remoteApiApiKey: string;
  searchProvider: "tavily" | "bing" | "serpapi";
  searchApiKey: string;
}
```

The route chooses exactly one provider. It does not automatically fall back to the other provider. Provider identity must be present in the response trace and card metadata. The existing search retry cap remains two attempts.

### 1.5 Trace contract

Extend the trace model with:

```ts
modelProvider: "llama.cpp" | "remote-api";
modelName: string;
modelBaseUrl: string;
```

Do not include the full transcript, API key, or full search response in the trace.

## 2. File Map and Ownership

### Phase P0: specification and baseline

Allowed files:

- `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`
- `task_plan.md`
- `progress.md`

No production code changes.

### Phase P1: provider migration and local end-to-end path

Allowed files:

- `types/settings.ts`
- `hooks/useSettings.ts`
- `hooks/useContextCards.ts`
- `components/SettingsModal.tsx`
- `lib/model-provider.ts`
- `lib/llama-cpp.ts`
- `lib/remote-api.ts`
- `lib/ollama.ts` for deletion only
- `app/api/context-cards/route.ts`
- `scripts/test-model-providers.ts`
- `scripts/test-context-card-route.ts`
- `docs/desktop-mvp.md`
- `progress.md`
- `task_plan.md`

If a test requires a new fixture, register its exact path in `task_plan.md` before creating it.

### Phase P2: replay and provider evaluation

Allowed files:

- `scripts/validate-replay.ts`
- `scripts/evaluate-model-providers.ts`
- `fixtures/`
- `reports/`
- `docs/evaluation/`
- `progress.md`
- `task_plan.md`

Do not change production provider code in P2.

### Phase P3: problem-driven repairs

Allowed files:

- only the production files already registered in P1;
- the corresponding P1/P2 tests;
- `docs/evaluation/`;
- `progress.md`;
- `task_plan.md`.

No training code, LoRA adapter, model merge, or quantization artifact is allowed in this phase.

## 3. Phase P0: Freeze the Execution Contract

### Task P0.1: Record baseline

**Allowed files:** `progress.md`, `task_plan.md`

Steps:

1. Record current branch and the existing clean/dirty baseline.
2. Record verified runtime artifacts:
   - `whisper.cpp 1.9.3-dev`
   - `/home/work/asr/.runtime/models/ggml-small.bin`
   - Qwen3 GGUF SHA256 `2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`
   - local `llama-server` binary and port used for smoke testing.
3. Record that the current 10-minute ASR replay has 321 transcript events and passes event validation.
4. Record that live search and remote API are not yet verified.

Checks:

```bash
git diff --check
npm run lint
npm run build
```

Review gate:

- no production file changed;
- unrelated untracked files preserved;
- baseline distinguishes implemented, configurable, planned, and unverified.

Phase checkpoint:

```bash
git add task_plan.md progress.md
git commit -m "docs: freeze llama provider execution baseline"
```

## 4. Phase P1: Provider Adapter Layer

### Task P1.1: Add provider types and typed errors

**Files:**

- Create: `lib/model-provider.ts`
- Modify: `types/settings.ts`
- Test: `scripts/test-model-providers.ts`

Implement:

```ts
export type ModelProviderName = "llama.cpp" | "remote-api";

export type ModelProviderErrorCode =
  | "model_unreachable"
  | "model_timeout"
  | "model_http_error"
  | "model_invalid_json"
  | "model_schema_invalid";
```

The test must assert provider-name validation, error-code serialization, and that API keys are not included in error messages.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
npx tsc --noEmit
```

### Task P1.2: Implement the OpenAI-compatible JSON client

**Files:**

- Modify: `lib/model-provider.ts`
- Test: `scripts/test-model-providers.ts`

The request must produce:

```json
{
  "model": "model-name",
  "messages": [
    {"role": "system", "content": "system text"},
    {"role": "user", "content": "user text"}
  ],
  "temperature": 0,
  "response_format": {"type": "json_object"}
}
```

Use an `AbortController` timeout. Parse only:

```json
{
  "choices": [
    {"message": {"content": "{\"keyword\":\"KV Cache\"}"}}
  ]
}
```

The test must use a local mock HTTP server and cover:

- successful JSON response;
- non-2xx HTTP response;
- timeout;
- invalid assistant JSON;
- missing assistant content;
- no Authorization header for an empty key;
- Bearer header for a non-empty key.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
npx tsc --noEmit
```

### Task P1.3: Add provider wrappers

**Files:**

- Create: `lib/llama-cpp.ts`
- Create: `lib/remote-api.ts`
- Modify: `scripts/test-model-providers.ts`

Each wrapper must export one function:

```ts
generateLlamaCppJson<T>(args): Promise<T>;
generateRemoteApiJson<T>(args): Promise<T>;
```

The wrappers must:

- use the shared client;
- preserve provider identity for trace callers;
- reject an empty base URL or model before making a network request;
- never log or throw API keys.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
npx tsc --noEmit
```

Review gate:

- no provider registry or speculative strategy pattern;
- one shared request implementation;
- local and remote differences are limited to configuration and identity.

## 5. Phase P1: Settings and Route Migration

### Task P1.4: Migrate settings and secret storage

**Files:**

- Modify: `types/settings.ts`
- Modify: `hooks/useSettings.ts`
- Test: `scripts/test-model-providers.ts`

Steps:

1. Add the seven model settings from section 1.2.
2. Default the provider to `llama.cpp`.
3. Store `llamaCppApiKey` and `remoteApiApiKey` outside the general preferences object.
4. Migrate existing `ollamaBaseUrl` and `ollamaModel` values once into the llama.cpp fields when present.
5. Remove old values from persisted preferences after migration.
6. Keep the existing Groq secret behavior unchanged.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
npx tsc --noEmit
```

### Task P1.5: Replace settings UI labels and fields

**Files:**

- Modify: `components/SettingsModal.tsx`
- Modify: `hooks/useContextCards.ts`

UI requirements:

- provider selector with `llama.cpp` and `远端 API`;
- local fields shown only for `llama.cpp`;
- remote fields shown only for `remote-api`;
- no visible Ollama label;
- explain that remote requests contain only minimum context, not full audio;
- pass all provider fields to `/api/context-cards`.

Checks:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## 6. Phase P1: Context-Card Route and Local Smoke

### Task P1.6: Route provider selection and failure states

**Files:**

- Modify: `app/api/context-cards/route.ts`
- Test: `scripts/test-context-card-route.ts`

Implementation rules:

1. Parse `modelProvider`.
2. Resolve local or remote settings.
3. Call the selected provider for keyword JSON.
4. Call the same selected provider for card JSON.
5. Keep search and source filtering unchanged.
6. Map provider errors to explicit failure reason strings and trace terminal states.
7. Do not call the other provider after a failure.
8. Include `modelProvider`, `modelName`, and `modelBaseUrl` in trace.

The test must cover:

- invalid request;
- local provider selected;
- remote provider selected;
- provider failure without silent fallback;
- invalid card schema;
- search failure after a successful keyword decision.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts
npm run lint
npx tsc --noEmit
npm run build
```

### Task P1.7: Remove Ollama runtime semantics

**Files:**

- Delete: `lib/ollama.ts`
- Modify: `README.md`
- Modify: `docs/desktop-mvp.md`
- Modify: `task_plan.md`
- Modify: `progress.md`

Rules:

- `rg -n "Ollama|ollama" app components hooks lib types README.md docs` must return no runtime/configuration references.
- Historical migration notes may mention the old provider only in the design/implementation plan and progress history.
- Update documentation to describe `llama.cpp` and explicit remote API selection.

Checks:

```bash
rg -n "Ollama|ollama" app components hooks lib types README.md docs
npm run lint
npx tsc --noEmit
npm run build
```

Expected result:

- no matches in runtime/configuration files;
- documentation and tests describe only `llama.cpp` and `remote-api`.

### Task P1.8: Run real local provider smoke

**Files:**

- Create: `scripts/run-local-model-smoke.ts`
- Modify: `docs/desktop-mvp.md`
- Modify: `progress.md`

Command:

```bash
TMPDIR=/tmp npx tsx scripts/run-local-model-smoke.ts \
  http://127.0.0.1:8082 \
  /home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  /tmp/cuemind-runtime/cuemind-10min-asr.json \
  /tmp/cuemind-runtime/local-model-smoke.json
```

The script must:

- read the first fixed 30-60 second transcript window;
- run keyword JSON generation;
- record provider, model, latency, output JSON, and error state;
- never record the API key;
- exit non-zero on invalid JSON or missing required fields.

The smoke report is evidence for local model structured output only. It is not evidence for search, card quality, or full end-to-end readiness.

Checks:

```bash
TMPDIR=/tmp npx tsx scripts/run-local-model-smoke.ts ...
```

## 7. Phase P1 Completion Gate

Required:

```bash
npm run lint
npx tsc --noEmit
npm run build
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts
```

Required runtime evidence:

- local `llama-server` health succeeds;
- local Qwen3 provider returns valid keyword JSON;
- 10-minute ASR replay remains valid;
- provider trace identifies `llama.cpp`;
- no automatic switch to remote provider occurs;
- search/live card generation is either verified or explicitly recorded as blocked.

Phase checkpoint:

```bash
git add app components hooks lib scripts types README.md docs/desktop-mvp.md task_plan.md progress.md
git commit -m "feat: replace Ollama with llama and remote providers"
```

## 8. Phase P2: Provider and Replay Evaluation

### Task P2.1: Extend replay evidence

**Allowed files:**

- `scripts/validate-replay.ts`
- `fixtures/`
- `reports/`

Add fields to the report:

- `modelProvider`
- `modelName`
- `modelBaseUrl` with host-only redaction if remote;
- `providerFailureCount`
- `invalidJsonCount`
- `schemaInvalidCount`
- `fallbackCount`, which must remain zero until explicit fallback is implemented.

Do not claim card quality from replay-only data.

### Task P2.2: Add repeated local provider evaluation

**Files:**

- Create: `scripts/evaluate-model-providers.ts`
- Modify: `docs/evaluation/`
- Modify: `reports/`

Run the same fixed ASR window three times against the local provider and write:

- `manifest.json`
- `outputs.jsonl`
- `errors.jsonl`
- `latency.jsonl`
- `scorecard.json`
- `report.md`

Report:

- valid JSON rate;
- schema validity;
- keyword repeat consistency;
- P50/P95 latency;
- denominator and excluded runs;
- model and llama.cpp versions;
- evidence boundary.

### Task P2.3: Add remote provider evaluation harness

**Files:**

- Modify: `scripts/evaluate-model-providers.ts`
- Modify: `docs/evaluation/`
- Modify: `reports/`

Remote evaluation runs only when the user explicitly supplies environment variables:

```bash
REMOTE_API_BASE_URL=...
REMOTE_API_MODEL=...
REMOTE_API_KEY=...
```

If missing, write `status=blocked_external_dependency`; do not fabricate a remote result.

Required remote evidence:

- provider name and model;
- API endpoint host without secret;
- latency;
- HTTP/auth/timeout errors;
- same input window as local evaluation.

## 9. Phase P2 Completion Gate

Required:

```bash
TMPDIR=/tmp npx tsx scripts/validate-replay.ts /tmp/cuemind-runtime/cuemind-10min-replay.jsonl /tmp/cuemind-runtime/replay-report
TMPDIR=/tmp npx tsx scripts/evaluate-model-providers.ts
npm run lint
npm run build
git diff --check
```

The report must state:

- local provider result;
- remote provider result or explicit blocked status;
- denominators;
- failed and excluded runs;
- no claim that replay proves live search or card quality.

Phase checkpoint:

```bash
git add fixtures reports scripts docs/evaluation progress.md task_plan.md
git commit -m "test: evaluate llama and remote providers"
```

## 10. Phase P3: Problem-Driven Repairs

P3 starts only after P2 has a reproducible error distribution. Valid repair targets:

- invalid JSON or schema failure;
- provider timeout or HTTP error classification;
- duplicate keyword/card behavior;
- trace completeness;
- remote data-boundary violations;
- prompt-injection handling;
- latency budget violations.

Each repair task must include:

1. one failing regression test;
2. the smallest production change;
3. rerun of the affected P2 evaluator;
4. full P1 gate;
5. before/after metrics;
6. updated `progress.md`.

No LoRA/SFT, model merge, or quantization work is allowed until P3 evaluation shows a stable dataset-backed need.

## 11. Phase-End Cleanup Audits

At the end of P1, inspect and record:

| Path | Type | Recommendation |
| --- | --- | --- |
| `lib/model-provider.ts` | Production provider client | keep |
| `lib/llama-cpp.ts` | Production local adapter | keep |
| `lib/remote-api.ts` | Production remote adapter | keep |
| `scripts/test-model-providers.ts` | Official regression script | keep |
| `scripts/test-context-card-route.ts` | Official route regression script | keep |
| `scripts/run-local-model-smoke.ts` | Official runtime smoke script | keep |
| `/tmp/cuemind-runtime/` | External runtime artifacts | review; do not commit large audio/model files |
| `lib/ollama.ts` | Removed legacy adapter | delete |

At the end of P2, additionally inspect:

| Path | Type | Recommendation |
| --- | --- | --- |
| `scripts/evaluate-model-providers.ts` | Evaluation script | keep |
| `reports/` | Evaluation artifacts | keep required manifests and reports; review raw outputs |
| `fixtures/` | Fixed replay inputs | keep frozen inputs; review duplicates |
| `dataset/` | User-provided source data | review; preserve unless explicitly approved for deletion |

Do not automatically delete any item during the audit.

## 12. Final Verification Checklist

- [ ] Git state inspected before implementation.
- [ ] Every task used a fresh subagent and stayed inside its file boundary.
- [ ] `modelProvider` is explicit and limited to `llama.cpp` or `remote-api`.
- [ ] No runtime/configuration path uses Ollama.
- [ ] Both providers use `/v1/chat/completions`.
- [ ] JSON output is locally parsed and schema-validated.
- [ ] API keys are not stored in general preferences or traces.
- [ ] No silent provider fallback exists.
- [ ] Local provider smoke is real and reproducible.
- [ ] Remote provider is either externally validated or explicitly blocked.
- [ ] Replay reports include denominator, failures, exclusions, provider, and model metadata.
- [ ] P1 and P2 each have one intentional commit.
- [ ] P3 only addresses reproduced failures.
- [ ] Phase-end cleanup audits are recorded in `progress.md`.

## 13. Handoff

After this plan is approved, execution starts at P0.1. The first implementation action is not to edit runtime code; it is to record the baseline and run the existing checks. After P0 is committed, continue with P1.1 through P1.8 one task at a time.
