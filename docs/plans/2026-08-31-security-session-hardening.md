# Security and Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the local CueMind deployment by enforcing session-token access, removing client control over server executable and vault paths, and fixing high-impact realtime reliability issues.

**Architecture:** Each persisted session owns a server-generated random access token; only its SHA-256 hash is stored with the session. Session-scoped routes require `X-Session-Token`, while the browser keeps the raw token in its existing `cuemind_*` local storage namespace. Server-side executable/model paths come only from environment configuration, and uploads remain in server-created temporary directories. Realtime card ingestion uses a pending queue so chunks arriving during an in-flight request are retried on the next cycle.

**Tech Stack:** Next.js 15 route handlers, React 19 hooks, TypeScript, Node `crypto`, existing SQLite/JSONL stores, existing `scripts/test-*.ts` regression scripts.

---

### Task 1: Add session token primitives and persistence

**Files:**
- Create: `lib/session-auth.ts`
- Modify: `lib/session-store.ts`
- Modify: `types/session.ts`
- Test: `scripts/test-session-auth.ts`

- [ ] Add failing tests for token generation, hash verification, and token persistence/lookup.
- [ ] Run `npx tsx scripts/test-session-auth.ts` and confirm failure because the auth API is absent.
- [ ] Implement `generateSessionAccessToken`, `hashSessionAccessToken`, and constant-time verification using Node `crypto`.
- [ ] Add `sessionAccessTokenHash` to the server-only `StoredSession` shape and SQLite/JSONL persistence. Do not return the hash in API responses.
- [ ] Preserve existing sessions by lazily assigning a token hash only when a trusted local client saves a session without one; reject reads that have no valid token.
- [ ] Run the auth regression and existing session-store regression.

### Task 2: Make `/api/sessions` the token bootstrap endpoint

**Files:**
- Modify: `app/api/sessions/route.ts`
- Modify: `app/page.tsx`
- Modify: `app/replay/page.tsx`
- Modify: `lib/session-storage.ts`

- [ ] Add a failing route test covering create/save response token, correct-token read, missing-token rejection, and wrong-token rejection.
- [ ] Make the first save of a new session generate and return the raw token; subsequent saves require the token and return no secret beyond the already-known token contract.
- [ ] Require the token for `GET ?id`, session list/search, and updates. Return a generic unauthorized/not-found response without revealing whether another session exists.
- [ ] Store raw tokens only in browser session storage/local storage under a namespaced key keyed by session ID; never put them in URLs or snapshots sent to the server.
- [ ] Add the token header to all browser requests that carry the active session ID.
- [ ] Run route and session persistence regressions.

### Task 3: Enforce session tokens across session-scoped APIs

**Files:**
- Modify: `app/api/chat-messages/route.ts`
- Modify: `app/api/pipeline-events/route.ts`
- Modify: `app/api/local-memory/route.ts`
- Modify: `app/api/context-cards/route.ts`
- Modify: `app/api/vault-export/route.ts`
- Modify: `app/api/session-title/route.ts`
- Modify: `app/api/postmeeting-transcript/route.ts`
- Modify: `app/api/local-transcribe/route.ts`
- Modify: `app/api/upload-media/route.ts`
- Modify: `app/api/ask/route.ts`
- Modify: `hooks/useContextCards.ts`
- Modify: `hooks/useAsk.ts`
- Modify: `hooks/useMicRecorder.ts`
- Modify: `hooks/useDesktopTranscript.ts`

- [ ] Add route-level regression coverage for cross-session token rejection on chat, pipeline, memory, cards, export, title, postmeeting, ASR, upload, and ask paths.
- [ ] Add one shared `requireSessionAccess` helper that validates `sessionId` plus `X-Session-Token` before any store access or expensive work.
- [ ] Pass session token through `fetch`, XHR, and multipart headers; do not put it in request bodies unless an existing transport cannot carry headers.
- [ ] Keep pure provider endpoints usable without a session only when they do not read/write session data.
- [ ] Run all affected route scripts.

### Task 4: Remove client-controlled executable and filesystem paths

**Files:**
- Modify: `lib/local-transcribe-contract.ts`
- Modify: `app/api/local-transcribe/route.ts`
- Modify: `lib/local-asr.ts`
- Modify: `lib/upload-media.ts`
- Modify: `app/api/upload-media/route.ts`
- Modify: `app/api/vault-export/route.ts`
- Modify: `lib/vault-exporter.ts`
- Test: `scripts/test-path-boundaries.ts`

- [ ] Add failing tests proving request fields cannot override whisper, model, ffmpeg, or vault paths.
- [ ] Resolve these values only from server environment variables with documented defaults; reject missing required binaries/models with stable errors.
- [ ] Keep `audioPath` restricted to the server-created temporary upload directory and verify resolved paths remain beneath that directory.
- [ ] Resolve vault output beneath the configured vault root and reject absolute paths and traversal.
- [ ] Return stable public error messages; log detailed process errors only on the server.
- [ ] Run media, ASR, vault, and path-boundary regressions.

### Task 5: Add uniform request limits and repair upload validation

**Files:**
- Modify: `lib/api-security.ts`
- Modify: `app/api/chat-messages/route.ts`
- Modify: `app/api/pipeline-events/route.ts`
- Modify: `app/api/context-cards/route.ts`
- Modify: `app/api/local-transcribe/route.ts`
- Modify: `app/api/upload-media/route.ts`
- Modify: `app/api/realtime-transcribe/route.ts`
- Modify: `app/api/session-title/route.ts`
- Modify: `app/api/sessions/route.ts`
- Modify: `lib/upload-media.ts`

- [ ] Add regression assertions for rate limiting, array limits, per-field character caps, and MIME-plus-extension validation.
- [ ] Apply existing `enforceRateLimit` to every expensive or persistent route.
- [ ] Enforce bounded messages/events/chunks before parsing or persistence; preserve existing product caps.
- [ ] Change the upload gate to the intended explicit rule `extensionInWhitelist && mimeAllowed`, while retaining supported WAV/WebM test fixtures.
- [ ] Run lint and affected regression scripts.

### Task 6: Fix realtime card queue and stale transcript context

**Files:**
- Modify: `hooks/useContextCards.ts`
- Modify: `lib/realtime-context-memory.ts` only if a pure queue helper is useful
- Test: `scripts/test-context-card-queue.ts`

- [ ] Add failing tests for chunks arriving while a request is running, during cooldown, after failure, and duplicate chunk IDs.
- [ ] Implement a bounded pending queue. Mark IDs processed only after the request accepts them; retain failed chunks up to a finite retry count.
- [ ] Read current transcript context through a ref so the request does not use an old closure.
- [ ] Preserve one-flight behavior and side-channel persistence semantics.
- [ ] Run queue, context-card, concurrency, and lint checks.

### Task 7: Verify production behavior and document deliberate scope

**Files:**
- Modify: `README.md` and `CLAUDE.md` only where security behavior is now different
- Modify: `docs/product/cuemind-grilling-decisions.md` only if implementation status needs correction

- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run lint` and confirm the missing-hook-dependency warning is gone.
- [ ] Stop any dev server before running `npm run build`; confirm exit code 0 and inspect native-module warnings.
- [ ] Run the focused regression scripts and `git diff --check`.
- [ ] Confirm no unrelated existing files were reverted or reformatted.
- [ ] Document that this is session isolation for a local deployment, not user authentication or multi-user authorization.
