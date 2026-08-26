# CueMind plan task tracking

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
- [ ] P1.4: migrate settings and secret storage.
- [ ] P1.5: replace settings UI labels and fields.
- [ ] P1.6: route provider selection and failure states.
- [ ] P1.7: remove Ollama runtime semantics.
- [ ] P1.8: run real local provider smoke.
- [ ] P2: replay and provider evaluation.
