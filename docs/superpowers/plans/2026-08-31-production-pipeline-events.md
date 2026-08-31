# Production Pipeline Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared, redacted, monotonic native timing events for capture, ASR, keyword extraction, and browser rendering, then consume them in request timeline reports.

**Architecture:** Extend the existing request timeline module with a validated event recorder and a best-effort JSONL sink. Propagate a single run ID through client requests and context-card traces; retain derived timing only for legacy responses and label it explicitly.

**Tech Stack:** TypeScript, React hooks, Next.js route handlers, browser `performance.now()`, Node JSONL files, existing assertion-style scripts.

---

### Task 1: Event contract and recorder

**Files:**
- Modify: `lib/request-timeline.ts`
- Create: `scripts/test-request-timeline-events.ts`

- [x] Write tests for valid event names, one run ID, monotonic timestamps, duplicate/retrograde rejection, null missing stages, and metadata redaction.
- [x] Run `TMPDIR=/tmp npx tsx scripts/test-request-timeline-events.ts` and observe the expected failure.
- [x] Add typed event creation, append validation, missing-stage extraction, and redacted JSONL append helpers.
- [x] Re-run the script and existing `scripts/test-performance-metrics.ts`.
- [x] Commit `feat: add validated production timeline events`.

### Task 2: Capture and ASR propagation

**Files:**
- Modify: `hooks/useMicRecorder.ts`
- Modify: `hooks/useDesktopTranscript.ts`
- Modify: `app/api/local-transcribe/route.ts`

- [x] Add a per-segment `runId` and send it with transcription requests.
- [x] Emit capture and ASR start/end events around the real work; preserve partial-only display and confirmed-only transcript semantics.
- [x] Add focused hook/request contract tests and run TypeScript checks.
- [x] Commit `feat: trace capture and asr boundaries`.

### Task 3: Keyword and render boundaries

**Files:**
- Modify: `hooks/useContextCards.ts`
- Modify: `app/api/context-cards/route.ts`
- Modify: `app/page.tsx`

- [x] Carry `runId` into context-card requests and traces.
- [x] Emit keyword start/end around the actual keyword model call.
- [x] Emit render start before card state commit and render end in `useLayoutEffect`; document the DOM-commit boundary.
- [x] Run context-card and UI type checks.
- [x] Commit `feat: trace keyword and render boundaries`.

### Task 4: Timeline evaluator and evidence

**Files:**
- Modify: `scripts/evaluate-request-timeline.ts`
- Modify: `lib/request-timeline.ts`
- Modify: `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md`

- [x] Prefer native events from responses/JSONL; keep old stage derivation only as `derived`.
- [x] Report eight native events, per-stage durations, null missing values, and observed/derived counts.
- [x] Run evaluator against the local service, then run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- [x] Record actual evidence boundaries and commit `docs: record native pipeline timing evidence`.
