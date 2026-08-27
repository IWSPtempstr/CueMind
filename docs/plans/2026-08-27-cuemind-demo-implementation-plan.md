# CueMind 最小演示版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `spec-first-harness` to implement this plan task-by-task. Every task has a fixed file boundary, validation commands, review gate, and progress update.

**Goal:** Build a reproducible 10-minute fixed-video demonstration that turns local ASR windows into 3-5 sourced Chinese context cards with explicit terminal states, latency evidence, and replay reports.

**Architecture:** Extend the existing Next.js, llama.cpp, search, desktop-event, and replay paths. Add only the smallest candidate-ledger and demo metadata contracts needed to make each window deterministic and auditable. Keep the existing three-column UI and provider boundary; do not introduce IndexedDB, a knowledge service, or a generic agent framework.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, native `fetch`, local whisper.cpp, llama.cpp OpenAI-compatible JSON API, existing search adapters, JSONL replay and Markdown/JSON reports.

---

## 0. Execution Rules

The plan is subordinate to:

- `docs/product/cuemind-grilling-decisions.md`
- `docs/plans/2026-08-27-cuemind-demo-design.md`
- `/root/.codex/skills/spec-first-harness/SKILL.md`

The working repository is `/home/work/asr/CueMind`, branch `codex/local-realtime-meeting-copilot`. The repository has existing untracked user/runtime paths. Preserve them:

- `dataset/`
- `findings.md`
- `docs/deployment/`
- existing untracked plan and product documents

The main agent owns Git operations. Each task is implemented in a fresh subagent and must stay within its declared files. The main agent reviews the diff, runs the checks, updates `progress.md` and `task_plan.md`, then closes the task before the next one. A failing task may receive at most three repair rounds.

## 1. Fixed Contracts

### 1.1 Demo manifest

Create `fixtures/demo-meeting/demo-manifest.json`:

```json
{
  "version": "demo-manifest-v1",
  "mediaPath": "dataset/【十字路口】探秘 Claude Code，搞懂 Agent Harness｜对谈来新璐【视频播客】 - Orig.mp4",
  "mediaSha256": "7a777fa685b0c2d7de5cc4bf53a10e2920a76fec91c5cc4948ab4a651607def6",
  "startMs": 0,
  "endMs": 600000,
  "scenario": "chinese-agent-technical-talk",
  "asrProvider": "local-whisper",
  "asrVersion": "whisper.cpp 1.9.3-dev + ggml-small.bin",
  "windowingVersion": "candidate-window-v1",
  "notes": "The segment is frozen after selection; changing it requires manifest v2."
}
```

The selected media file and hash are recorded during Task 1. A later task may not silently replace the segment.

### 1.2 Candidate ledger

Each candidate replay record must contain:

```ts
interface DemoCandidateRecord {
  candidateId: string;
  datasetVersion: string;
  mediaId: string;
  coreStartMs: number;
  coreEndMs: number;
  contextStartMs: number;
  contextEndMs: number;
  transcriptChunkIds: string[];
  windowCloseReason: "pause" | "sentence_end" | "speaker_change" | "semantic_boundary" | "max_duration" | "end_of_input";
  finalState:
    | "card_shown"
    | "model_skip"
    | "suppressed_as_duplicate"
    | "search_failed"
    | "model_failed"
    | "timeout"
    | "invalid_schema"
    | "remote_blocked"
    | "excluded_unscorable";
  traceId: string;
}
```

Candidate IDs are derived from manifest version, media ID, core interval, ASR version and windowing version. Replaying the same manifest and transcript must produce the same ledger keys.

### 1.3 Card and trace additions

Extend the existing context-card response without breaking current fields:

```ts
interface DemoTraceFields {
  candidateId: string;
  datasetVersion: string;
  windowingVersion: string;
  finalState: string;
  decisionSource: "hard_rule" | "model" | "search" | "system";
  duplicateOfCandidateId?: string;
}
```

Do not place full transcript text, API keys, authorization headers, cookies or complete search responses in traces or reports.

### 1.4 Validation commands

Every task must run the narrowest relevant script plus:

```bash
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

The final phase additionally runs:

```bash
TMPDIR=/tmp npx tsx scripts/validate-replay.ts fixtures/demo-meeting/sample-events.jsonl reports/replay
TMPDIR=/tmp npx tsx scripts/run-context-card-replay.ts
TMPDIR=/tmp npx tsx scripts/evaluate-end-to-end.ts
```

Live external services are evidence inputs, not prerequisites for deterministic unit/contract checks. A blocked external dependency must be reported explicitly and must not be fabricated as a pass.

## 2. File Map

Existing files to modify:

- `types/suggestions.ts`: demo card metadata and failure/terminal fields.
- `lib/desktop-events.ts`: candidate/window event validation only if the event contract requires it.
- `lib/replay.ts`: deterministic candidate-window and replay helpers.
- `app/api/context-cards/route.ts`: hard-rule decision, candidate metadata, terminal states, and trace.
- `hooks/useContextCards.ts`: candidate submission, duplicate handling, card/failure state.
- `components/LiveSuggestions.tsx`: current-card focus, bounded list, concise degraded states.
- `components/LatencyPanel.tsx`: demo health metrics only.
- `app/page.tsx`: wire frozen replay/demo state and current-card presentation if needed.
- `scripts/run-context-card-replay.ts`: manifest-driven replay and trace-bearing JSONL output.
- `scripts/validate-replay.ts`: candidate-ledger conservation and terminal-state checks.
- `scripts/evaluate-end-to-end.ts`: final demo report and explicit evidence boundary.
- `docs/desktop-mvp.md`: update only verified demo evidence and remaining Windows gaps.
- `progress.md`, `task_plan.md`: main-agent progress bookkeeping.

Files to create:

- `fixtures/demo-meeting/demo-manifest.json`
- `scripts/test-demo-windowing.ts`
- `scripts/test-demo-ledger.ts`

Do not create a database layer, provider registry, agent framework, or knowledge-base module in this plan.

## 3. Phases and Tasks

### Phase A: Freeze the demonstration input and contracts

#### Task 1: Freeze the 10-minute demonstration manifest

**Files:**

- Create: `fixtures/demo-meeting/demo-manifest.json`
- Modify: `fixtures/demo-meeting/README.md`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Inspect the existing `dataset/` videos and select the Chinese AI Agent technical-talk file matching the product decision.
- [ ] Measure duration, choose a fixed 600,000 ms segment, calculate SHA256, and record the exact file path, start/end time, ASR runtime and model versions.
- [ ] Write the manifest using `demo-manifest-v1`; document that changing media, time range or windowing requires a new manifest version.
- [ ] Run `sha256sum`, JSON parsing, `git diff --check`, `npm run lint`, and `npm run build`.

Review gate: the manifest is reproducible and no report calls an unfrozen segment the golden demo.

#### Task 2: Define deterministic mixed-window behavior

**Files:**

- Create: `scripts/test-demo-windowing.ts`
- Modify: `lib/replay.ts`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add failing cases for sentence-boundary closure, 2-second context overlap, minimum accumulation, 12-second maximum, end-of-input closure and duplicate overlap exclusion.
- [ ] Implement the smallest pure helper in `lib/replay.ts` that accepts ordered stable transcript chunks and returns core interval, context interval, close reason and stable candidate ID inputs.
- [ ] Make the test assert exact intervals and close reasons for a fixed fixture; do not use wall-clock time or random IDs.
- [ ] Run `TMPDIR=/tmp npx tsx scripts/test-demo-windowing.ts`, then the full TypeScript/lint/build/diff checks.

Review gate: the helper has no network, storage or UI responsibility and the same input yields the same windows.

### Phase B: Make the card route candidate-ledger aware

#### Task 3: Add explicit decision and terminal-state fields

**Files:**

- Modify: `types/suggestions.ts`
- Modify: `app/api/context-cards/route.ts`
- Modify: `scripts/test-context-card-route.ts`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add failing route assertions for `candidateId`, `datasetVersion`, `windowingVersion`, `decisionSource` and terminal states.
- [ ] Extend request parsing with bounded demo metadata and reject malformed candidate intervals or missing IDs.
- [ ] Preserve the existing exact-one-provider behavior and search retry cap of two attempts.
- [ ] Emit `model_skip` for a generic/duplicate keyword, `search_failed` for search failure, `model_failed` for provider failure, `invalid_schema` for parsed-but-invalid card JSON, and `card_shown` for success.
- [ ] Keep all terminal fields in the response trace and never include secrets or full transcript payloads in trace metadata.
- [ ] Run `TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts` and all static checks.

Review gate: every request has one final state, and failure categories remain distinguishable.

#### Task 4: Enforce conservative duplicate suppression

**Files:**

- Modify: `app/api/context-cards/route.ts`
- Modify: `hooks/useContextCards.ts`
- Modify: `scripts/test-context-card-route.ts`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add failing cases for case/whitespace-normalized duplicate keywords, repeated overlap windows and a distinct keyword in the same meeting.
- [ ] Normalize only the deterministic fields required for exact matching; do not add semantic similarity or learned suppression.
- [ ] Return `suppressed_as_duplicate` with `duplicateOfCandidateId` and keep the candidate in the trace/replay ledger.
- [ ] Make the hook avoid inserting suppressed cards while retaining the failure/status record for the health panel.
- [ ] Run route regression plus TypeScript/lint/build/diff checks.

Review gate: duplicate suppression never deletes the candidate record and never suppresses a clearly different normalized keyword.

### Phase C: Finish the fixed replay and UI demonstration path

#### Task 5: Make replay manifest-driven and ledger-complete

**Files:**

- Modify: `scripts/run-context-card-replay.ts`
- Modify: `scripts/validate-replay.ts`
- Create: `scripts/test-demo-ledger.ts`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add failing ledger tests for stable IDs, one terminal state per candidate, duplicate-ID detection, excluded-input accounting and conservation: input = evaluable + excluded; evaluable = terminal-state totals.
- [ ] Load `demo-manifest.json` by default and include manifest/version metadata in each replay record.
- [ ] Ensure mock mode remains deterministic and live mode records actual provider/search/card trace without API keys or unbounded transcript content.
- [ ] Update the validator to reject missing candidate IDs, missing terminal states, duplicate candidate IDs and conservation mismatches.
- [ ] Run the ledger script, fixture replay validator, and full static checks.

Review gate: replay output can be audited from input window to one terminal state without reading application logs.

#### Task 6: Render the bounded three-column demo state

**Files:**

- Modify: `components/LiveSuggestions.tsx`
- Modify: `components/LatencyPanel.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add a failing browser-level checklist or deterministic component assertions for one focused current card, scrollable prior cards, visible source status and no overlapping three-column layout at desktop width.
- [ ] Keep the current card visually primary; place older successful cards in a bounded scroll region and show overflow/degraded states as text.
- [ ] Restrict the right panel to ASR state, latest total latency, card count, queue count and degradation state; do not expose raw model output or full trace.
- [ ] Preserve keyboard focus, semantic labels, reduced-motion behavior and existing dark control-room styling.
- [ ] Run `npm run lint`, `npx tsc --noEmit`, `npm run build` and a local dev smoke at the existing app URL.

Review gate: the main screen communicates the live workflow without turning telemetry or chat into the visual center.

### Phase D: Evidence, report and handoff

#### Task 7: Produce the end-to-end demo report

**Files:**

- Modify: `scripts/evaluate-end-to-end.ts`
- Modify: `docs/desktop-mvp.md`
- Modify: `progress.md`
- Modify: `task_plan.md`

Steps:

- [ ] Add report fields for manifest version, candidate denominator, card count, terminal-state counts, source-validity count, latency P50/P95, and blocked external dependencies.
- [ ] Run the deterministic fixture/replay path first; then run the live local path only when the verified local ASR/model/search runtime is available.
- [ ] Report 3-5 cards as the demo target, not as an unconditional pass; preserve the actual denominator and list failures.
- [ ] Update `docs/desktop-mvp.md` only with observed evidence, explicitly retaining Windows helper, dual-track capture, packaging and live search gaps.
- [ ] Run `TMPDIR=/tmp npx tsx scripts/validate-replay.ts fixtures/demo-meeting/sample-events.jsonl reports/replay`, `TMPDIR=/tmp npx tsx scripts/run-context-card-replay.ts`, `TMPDIR=/tmp npx tsx scripts/evaluate-end-to-end.ts`, and all static checks.

Review gate: the report distinguishes deterministic contract evidence, live local evidence, blocked external dependencies and unverified production claims.

#### Task 8: Final verification and phase-end cleanup audit

**Files:**

- Modify: `progress.md`
- Modify: `task_plan.md`
- Modify: `docs/desktop-mvp.md` only if verification evidence requires a factual correction

Steps:

- [ ] Re-read the product decision record and this plan; verify every in-scope requirement maps to a completed task.
- [ ] Run `npx tsc --noEmit`, `npm run lint`, `npm run build`, `git diff --check` and all deterministic regression scripts.
- [ ] Inspect touched code for temporary test files, debug prints, fake data, one-off scripts and generated artifacts.
- [ ] Record a cleanup checklist with path, item type, purpose, recommendation (`keep`, `delete` or `review`) and rationale.
- [ ] Do not delete existing official regression scripts, formal production code, user-provided dataset files or approved evidence artifacts automatically.

Review gate: no task is marked complete with a failing check, and all remaining limitations are visible in the handoff.

## 4. Explicitly Out of Scope for This Plan

The following are deliberately excluded from every task boundary:

- IndexedDB/SQLite knowledge persistence and import/export.
- `provisional`/`active` knowledge lifecycle and cross-meeting reuse.
- User feedback learning, context-level negative feedback and suggestion-level suppression.
- Post-meeting knowledge review, source conflict workflow and version rollback UI.
- Background source freshness validation and risk-based source replacement.
- LLM Judge, human audit sampling and frozen-set quality release gates.
- Online model training, automatic Prompt changes and dynamic public taxonomy changes.
- Full meeting-level remote authorization and privacy-policy management UI.
- Milvus/embedding semantic retrieval in the realtime path.
- Windows hardware acceptance, helper compilation, installer packaging and production SLA.

If a task appears to require one of these capabilities, stop and request a spec revision rather than expanding the task boundary.

## 5. Phase-End Cleanup Audit Template

At the end of each phase, record:

| Path | Item type | Current purpose | Recommendation | Rationale |
| --- | --- | --- | --- | --- |
| `scripts/test-demo-windowing.ts` | deterministic regression script | Verifies stable candidate intervals and close reasons | keep | It is the official contract check for the demo windowing boundary. |

Formal business code, official regression tests, approved reports and user-provided dataset files are not disposable by default.
