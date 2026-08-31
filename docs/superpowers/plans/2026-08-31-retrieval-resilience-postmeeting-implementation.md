# Retrieval Resilience and Postmeeting Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reproducible retrieval/cache resilience evidence and postmeeting polished, redacted, time-linked exports without changing raw meeting data.

**Architecture:** Keep search and cache behavior in the existing `lib/search.ts` and `lib/ask-cache.ts` boundaries. Add a fixture-driven evaluator with explicit cache-origin classifications. Extend the existing export pipeline with immutable raw input, optional postmeeting polish metadata, deterministic redaction, and a timeline sidecar keyed by existing transcript/card/ask identifiers.

**Tech Stack:** TypeScript, Node `assert`, Next.js route handlers, existing JSONL/Markdown exporters, local llama.cpp provider, SQLite/browser session snapshot contracts.

---

### Task 1: Define cache-origin and resilience report contracts

**Files:**
- Modify: `lib/ask-cache.ts`
- Create: `lib/retrieval-resilience.ts`
- Test: `scripts/test-retrieval-resilience.ts`

- [ ] **Step 1: Write the failing test**

Add assertions for normalized keys, explicit cache origin, TTL expiry, and four report classifications:

```ts
import assert from "node:assert/strict";
import { createAskCache, ASK_CACHE_TTL_MS } from "@/lib/ask-cache";
import { classifyCacheObservation } from "@/lib/retrieval-resilience";

let now = 1_000;
const cache = createAskCache(() => now);
cache.set("  KV Cache ", [], "ask");
assert.deepEqual(cache.get("kv cache")?.origin, "ask");
assert.equal(classifyCacheObservation({ before: false, warmedBy: "context_card", hit: true }), "card_warmed_hit");
assert.equal(classifyCacheObservation({ before: false, warmedBy: "ask", hit: true }), "ask_hot_hit");
now += ASK_CACHE_TTL_MS;
assert.equal(cache.get("KV CACHE"), null);
assert.equal(classifyCacheObservation({ before: false, warmedBy: null, hit: false }), "expired_miss");
console.log("retrieval resilience contract red test passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-retrieval-resilience.ts`
Expected: FAIL because `AskCache.set` does not accept an origin and `lib/retrieval-resilience.ts` is missing.

- [ ] **Step 3: Write minimal implementation**

Extend the cache entry with `origin: "ask" | "context_card"`, return `{ results, origin }` from `get`, and add `classifyCacheObservation` with the four literal classifications. Update only existing call sites to read `.results`; preserve the existing TTL and key normalization.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-retrieval-resilience.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ask-cache.ts lib/retrieval-resilience.ts scripts/test-retrieval-resilience.ts
git commit -m "feat: add cache origin resilience contracts"
```

### Task 2: Build fixture-driven retrieval resilience evaluator

**Files:**
- Create: `fixtures/retrieval-resilience-v1.json`
- Create: `scripts/evaluate-retrieval-resilience.ts`
- Modify: `scripts/test-retrieval-resilience.ts`

- [ ] **Step 1: Write the failing test**

Add a test that runs the evaluator against a local fixture and asserts the report has exactly the cases `single_vertical_timeout`, `vertical_fallback`, `all_sources_timeout`, `cold_miss`, `card_warmed_hit`, `ask_hot_hit`, `expired_miss`, and `alias_normalization`; assert `freezeExcluded === 0` and that no case reports an unclassified cache hit.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-retrieval-resilience.ts`
Expected: FAIL because the evaluator and fixture do not exist.

- [ ] **Step 3: Write minimal implementation**

Create a fixture containing mocked source responses, timeout/error directives, expected terminal states, and cache setup. Implement the evaluator with an injected `fetch` responder and injected clock. Execute vertical-source and fallback paths through existing `searchKeywordSources`; do not alter `searchWeb` signature. Write `manifest.json`, `cases.jsonl`, `failures.jsonl`, `scorecard.json`, and `report.md` under `reports/retrieval-resilience/<run-id>/`. Mark fixture execution separately from live execution.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-retrieval-resilience.ts`
Expected: PASS and a temporary report with all required classifications.

- [ ] **Step 5: Commit**

```bash
git add fixtures/retrieval-resilience-v1.json scripts/evaluate-retrieval-resilience.ts scripts/test-retrieval-resilience.ts
git commit -m "feat: add retrieval resilience evaluator"
```

### Task 3: Wire cache-origin semantics without changing fail-closed behavior

**Files:**
- Modify: `app/api/context-cards/route.ts`
- Modify: `app/api/ask/route.ts`
- Modify: `scripts/test-ask-route.ts`
- Modify: `scripts/test-context-card-route.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that a context-card search write uses origin `context_card`, an Ask search write uses origin `ask`, and source shortage still returns `search_failed`/no card. Assert no route returns a card when fewer than two usable sources are available.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-ask-route.ts && npx tsx scripts/test-context-card-route.ts`
Expected: FAIL on the origin assertion before route wiring is updated.

- [ ] **Step 3: Write minimal implementation**

Pass the explicit origin at each cache write and adapt reads to the new cache return shape. Keep context-card and Ask cache namespaces/semantics unchanged otherwise. Preserve fail-closed source validation and candidate terminal states.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-ask-route.ts && npx tsx scripts/test-context-card-route.ts && npx tsx scripts/test-retrieval-resilience.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/context-cards/route.ts app/api/ask/route.ts scripts/test-ask-route.ts scripts/test-context-card-route.ts
git commit -m "feat: distinguish ask and card cache warming"
```

### Task 4: Add postmeeting polished transcript contract

**Files:**
- Modify: `types/session.ts`
- Create: `lib/postmeeting-transcript.ts`
- Modify: `lib/session-storage.ts`
- Test: `scripts/test-postmeeting-experience.ts`

- [ ] **Step 1: Write the failing test**

Test that a successful polish result carries raw-text identity, provider/prompt metadata, and generated time; a provider failure returns the original chunks and a failure reason; raw chunk text and timestamps are unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-postmeeting-experience.ts`
Expected: FAIL because the postmeeting result type and function are missing.

- [ ] **Step 3: Write minimal implementation**

Add optional session fields for a postmeeting transcript artifact. Implement a server-side helper that receives raw chunks, invokes existing `polishTranscript` only after meeting end, and returns `{ status, text, rawHash, provider, promptVersion, generatedAt, failureReason? }`. Never mutate `transcriptChunks`; return raw text on timeout, empty output, invalid output, or provider failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-postmeeting-experience.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add types/session.ts lib/postmeeting-transcript.ts lib/session-storage.ts scripts/test-postmeeting-experience.ts
git commit -m "feat: add postmeeting transcript artifact"
```

### Task 5: Add deterministic redacted export copies

**Files:**
- Create: `lib/redaction.ts`
- Modify: `lib/export.ts`
- Modify: `app/api/vault-export/route.ts`
- Test: `scripts/test-postmeeting-experience.ts`

- [ ] **Step 1: Write the failing test**

Test email, phone, API-key-like strings, and user dictionary entities are replaced with stable placeholders; the redaction manifest contains counts and rule version but never original values; the input snapshot remains unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-postmeeting-experience.ts`
Expected: FAIL because `lib/redaction.ts` and redacted export options are missing.

- [ ] **Step 3: Write minimal implementation**

Implement ordered deterministic regexes plus a caller-supplied dictionary. Use per-type counters (`[PERSON_1]`, `[ORG_1]`, `[SECRET_1]`, etc.) stable within one export. Add an explicit `redact` option to JSON/Markdown export and Vault export; write only the redacted copy and a `redaction-manifest.json` sidecar. Include `ruleVersion`, replacement counts, and `manualReviewRequired: true`; never persist matched source values.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-postmeeting-experience.ts && npx tsx scripts/test-vault-exporter.ts`
Expected: PASS with existing non-redacted export behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/redaction.ts lib/export.ts app/api/vault-export/route.ts scripts/test-postmeeting-experience.ts
git commit -m "feat: add deterministic redacted exports"
```

### Task 6: Add timeline sidecar and export anchors

**Files:**
- Create: `lib/timeline.ts`
- Modify: `lib/export.ts`
- Modify: `lib/vault-exporter.ts`
- Test: `scripts/test-postmeeting-experience.ts`

- [ ] **Step 1: Write the failing test**

Create chunks, a card with `candidateId`, and an ask with a timestamp range. Assert generated timeline entries preserve exact `startMs/endMs`, refer to existing IDs, and render `[mm:ss]` anchors in Markdown without inventing audio URLs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-postmeeting-experience.ts`
Expected: FAIL because the timeline builder is missing.

- [ ] **Step 3: Write minimal implementation**

Define timeline entries for `transcript`, `card`, `ask`, and `report` with stable IDs and optional start/end milliseconds. Build `timeline.json` alongside export output. Keep existing Vault frontmatter and transcript modes; add anchor IDs and a timeline reference only where timestamps exist. Do not emit playback links or `cuemind://` URLs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-postmeeting-experience.ts && npx tsx scripts/test-vault-exporter.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/timeline.ts lib/export.ts lib/vault-exporter.ts scripts/test-postmeeting-experience.ts
git commit -m "feat: add timestamped meeting timeline export"
```

### Task 7: Add user-facing postmeeting export integration and documentation

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/MicTranscript.tsx`
- Modify: `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md`
- Modify: `docs/plans/2026-08-31-retrieval-resilience-postmeeting-design.md`
- Test: `scripts/test-postmeeting-experience.ts`

- [ ] **Step 1: Write the failing test**

Add a route/component-level assertion that the postmeeting action is unavailable while recording, preserves the raw transcript, and exposes separate raw/整理版 and redacted export choices after completion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-postmeeting-experience.ts`
Expected: FAIL because the UI/export integration is missing.

- [ ] **Step 3: Write minimal implementation**

Wire postmeeting polish after the meeting stop path, keep the raw transcript as the primary visible text, and add explicit export options for raw or polished plus redacted copy. Show manual-review status for redaction. Keep real-time card and ASR paths untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/test-postmeeting-experience.ts && npm run lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx components/MicTranscript.tsx docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md docs/plans/2026-08-31-retrieval-resilience-postmeeting-design.md scripts/test-postmeeting-experience.ts
git commit -m "feat: integrate postmeeting export workflow"
```

### Task 8: Full verification and evidence report

**Files:**
- Create: `reports/retrieval-resilience/<run-id>/` (runtime output, do not commit large data)
- Modify: `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md`

- [ ] **Step 1: Run focused regressions**

Run:

```bash
npx tsx scripts/test-retrieval-resilience.ts
npx tsx scripts/test-postmeeting-experience.ts
npx tsx scripts/test-vertical-sources.ts
npx tsx scripts/test-vault-exporter.ts
```

Expected: all suites pass.

- [ ] **Step 2: Run repository gates**

Stop any `:3000` dev server before the build, then run:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Run evaluator and inspect evidence boundary**

Run: `npx tsx scripts/evaluate-retrieval-resilience.ts --fixture fixtures/retrieval-resilience-v1.json --output reports/retrieval-resilience/<run-id>`

Verify the report distinguishes fixture from live evidence, includes all denominators and failure cases, records no secrets, and reports `freezeExcluded=0`.

- [ ] **Step 4: Update the main plan with evidence**

Record report path, commit, test commands, and any unverified Windows/player boundary under Stage 8A/8B. Do not claim audio playback acceptance.

- [ ] **Step 5: Commit**

```bash
git add docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md
git commit -m "docs: record resilience and postmeeting evidence"
```
