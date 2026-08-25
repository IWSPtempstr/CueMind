# CueMind plan task tracking

## Objective

Execute the P0-P3 specification in `docs/plans/2026-08-25-cuemind-detailed-implementation-plan.md` for CueMind's local-first realtime meeting cognition assistant. Each phase is reviewed, validated, and committed once before the next phase starts.

## Current Phase

- [x] P0: supplement execution specification and submission rules.
- [x] P1: implement the local whisper.cpp ASR contract and serialized desktop transcription path.
- [x] P2: establish fixture replay validation and evidence-boundary reporting.
- [ ] P3: optimize only reproducible failures from P2.

P0 is documentation-only. The current request does not claim that any runtime capability is complete.

## Phase Gates

| Phase | Scope | Required gate | Commit |
| --- | --- | --- | --- |
| P0 | Specs, status, and boundaries | `git diff --check`; `npm run lint`; `npm run build` | `docs: define CueMind execution spec` |
| P1 | Complete local replay-to-card chain | Lint/build, ASR smoke test, fixed replay, Schema validation | `feat: complete CueMind local replay loop` |
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

- Local `whisper.cpp` executable, model path, timestamp behavior, and Chinese ASR quality are not yet verified.
- Local Qwen3-4B structured output, search provider behavior, Agent trace completeness, and real latency are not yet verified.
- End-to-end file replay, microphone input, Windows audio capture, remote fallback, and knowledge persistence are not yet verified.
- A real `whisper-cli` executable and model were not present in the WSL workspace, so the real-model smoke test remains blocked by missing external runtime artifacts.
- P2 currently validates fixture event integrity and supplied ASR latency metadata; it does not claim real ASR, local LLM, live search, or card-quality evidence.
