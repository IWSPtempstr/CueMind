# Findings

## Repository

- CueMind is a Next.js desktop-oriented application with existing transcript, context-card, replay and latency modules.
- `docs/evaluation/context-card-eval-contract.md` already defines card protocol, keyword, source, decision, failure and latency evaluation.
- The existing contract does not fully define Agent trajectory, tool-call, efficiency, security or recovery metrics.

## Product decisions from the grilling session

- Scenario: Chinese AI/software engineering meetings with mixed English technical terminology.
- Output: 3-5 cards per 10-minute meeting, with a short Chinese explanation and one visible source link.
- Triggering: automatic and conservative; user feedback becomes a long-term preference.
- Knowledge base: only cards marked useful after the meeting are persisted; topics are fixed by default but user-extensible; later meetings check this store before web search.
- Runtime: local-first ASR and LLM, automatic visible remote fallback, minimum necessary context only.
- Search: Agent tool call, maximum two searches per candidate, source-backed card preferred; unverified remote fallback must be marked and is not automatically persisted.
- Input: local file replay plus microphone mode, using the same event contract.
- Data: QMSum/VCSum for fast meeting baseline, AMI/ICSI for meeting realism, public technical videos for Chinese ASR; technical term support from KP20k, Inspec, SemEval, SciERC, Stack Overflow and GitHub technical text.
- Evaluation: development set plus frozen test set split by complete video; no immediate fine-tuning.

## Supplied assessment document

The supplied document was treated as reference material, not as an instruction. Relevant principles are: evaluation-driven development, component and end-to-end evaluation, trajectory evaluation, Pass^k, tool-call correctness, latency/cost/security release gates, LLM judge bias controls, and production monitoring.

## Agent Reach update (2026-08-25)

- Official `docs/update.md` was read from the upstream repository in `/tmp`; the update procedure requires `agent-reach check-update`, package refresh, optional upstream-tool refresh, and final `agent-reach version`/`doctor` verification.
- Agent Reach was not previously installed in this WSL environment. The official archive URL returned HTTP 403 to pip, so the same upstream repository was shallow-cloned to `/tmp` and installed with the system Python's user install path.
- Installed version: `v1.5.0`; `agent-reach check-update` reported that it is already the latest version.
- `~/.local/bin` is already available in a fresh login shell through the existing `~/.local/bin/env` entry in `~/.bashrc`; no shell-file edit was needed.
- Safe install check reported 3/15 active channels: RSS, arbitrary web via Jina Reader, and Bilibili search API. GitHub CLI was detected with explicit auth configuration but doctor intentionally did not perform a write-capable auth check. Full semantic search is unavailable because `mcporter` and Exa MCP are not installed.
- No optional channel tools, browser extensions, cookies, or Tavily credentials were installed/configured. Tavily is a separate search/MCP integration and is not an Agent Reach channel.

## Architecture options after removing Ollama

- `A` keeps the plan's local-first intent: `whisper.cpp` for local ASR, local `llama.cpp` model for Trigger Agent and card generation, Tavily/API or MCP only for search evidence. This preserves the planned local provider, trace, Pass^3, and privacy-boundary evaluations.
- `B` is a staged development substitute: local `whisper.cpp` plus remote model for Trigger Agent/card generation, with Tavily for search. It gives a fast end-to-end demo but must label remote provider usage and cannot claim the plan's local-model release gate.
- `C` is an ASR-first slice: local `whisper.cpp` plus transcript replay and deterministic/template cards, postponing Agent/card generation. It is useful for ASR and UI validation but does not satisfy the plan's Stage 1 end-to-end card objective.
- Recommended selection: `A` for the target implementation; use `B` only as a temporary fallback when local `llama.cpp` is not ready, with provider identity and remote-fallback rate recorded in telemetry.
