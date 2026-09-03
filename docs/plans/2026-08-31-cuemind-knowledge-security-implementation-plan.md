# CueMind Security Hardening and Knowledge Base Implementation Plan

> Date: 2026-08-31
> Status: active
> Scope: local CueMind deployment only
> Related plans:
> - `docs/plans/2026-08-31-security-session-hardening.md`
> - `docs/plans/2026-08-31-retrieval-resilience-postmeeting-design.md`
> - `docs/plans/2026-08-27-cuemind-knowledge-export-mcp-plan.md`
> - `docs/product/cuemind-grilling-decisions.md`
>
> This document is the consolidated execution entry for the remaining security hardening work and the staged A-D implementation of the knowledge base product. Existing topic-specific plans remain valid; this file defines sequencing, scope boundaries, dependencies, and acceptance criteria in one place.

## 1. Background and Goal

CueMind already has a local-first session model, realtime transcription pipeline, context-card generation, session persistence, and vault export capability. Recent hardening work closed the highest-risk gaps around session access, client-controlled server paths, and several expensive route boundaries.

The next step is to stop treating security hardening and knowledge-product work as separate floating threads. They share the same session model, storage model, and export boundaries. This plan therefore establishes one implementation sequence:

1. finish the remaining HTTP security boundaries and regression coverage;
2. productize the knowledge base in four explicit phases;
3. keep vault sync, privacy, and MCP read paths consistent with the same session-scoped storage contract.

## 2. Scope and Non-Goals

### In scope

- Session-scoped isolation for a local deployment.
- Strict server ownership of executable paths, model paths, and vault root paths.
- Unified request boundary enforcement for expensive or persistent HTTP routes.
- A staged local knowledge base built on SQLite with JSONL fallback.
- A dedicated `/knowledge` management UI.
- Vault synchronization with conflict detection.
- Privacy review states before local save or remote send.
- Read-only MCP tools for knowledge retrieval.

### Out of scope

- User accounts, multi-user authorization, OAuth, or shared remote identity.
- Vector databases, embeddings, Milvus, or semantic retrieval infrastructure.
- Cloud knowledge sinks, Feishu, remote sync targets, or write-capable MCP tools.
- Automatic TTL-based knowledge deletion.
- Blind overwriting of vault files edited outside CueMind.

## 3. Current State

### Completed security work

The repository already includes the following hardening work:

- Session access tokens are generated per session, stored server-side only as SHA-256 hashes, and sent by clients using `X-Session-Token`.
- `requireSessionAccess` is the shared route-level gate for session-scoped APIs.
- Client-controlled `whisperPath`, `whisperModelPath`, `modelPath`, `ffmpegPath`, and `vaultPath` have been removed from HTTP control surfaces.
- Realtime transcription, upload, summarize, suggestions, session-title, and postmeeting transcript routes now enforce session access before expensive work.
- Several high-cost routes already reject oversized arrays or fields instead of silently truncating them.
- Focused route regressions, TypeScript checks, and lint are passing for the completed hardening phases.

### Completed knowledge phase A

Phase A is already implemented and validated:

- `lib/knowledge-store.ts` provides `KnowledgeStore` with SQLite primary storage and JSONL fallback.
- `app/api/knowledge/route.ts` implements session-scoped list, search, detail, create, edit, and soft-delete behavior.
- `PATCH` uses explicit `version` optimistic locking and returns `409` on version mismatch.
- Knowledge creation supports `cardId` and verifies card origin ownership through the current session.
- `scripts/test-knowledge-route.ts` covers the minimal CRUD and auth contract.
- Phase A has its own local commit: `f399c68 feat: add knowledge entry API`.

### Existing constraints from related plans

The following constraints remain binding:

- `docs/plans/2026-08-31-security-session-hardening.md`: local session isolation only, no user auth; route-level protection before expensive work; no client path control.
- `docs/plans/2026-08-31-retrieval-resilience-postmeeting-design.md`: raw transcript remains immutable; redaction applies to export copies only; vault artifacts must not be silently overwritten.
- `docs/plans/2026-08-27-cuemind-knowledge-export-mcp-plan.md`: vault stays the only external sink; MCP remains read-only; no cloud endpoints.
- `docs/product/cuemind-grilling-decisions.md`: excluded demo-scope items remain excluded until separately versioned.

## 4. Architecture Decisions

### 4.1 Session model

CueMind remains a local app with per-session authorization, not user identity. Every session owns one random access token. The server stores only the hash. Any session-scoped route must validate `sessionId` plus `X-Session-Token` before reading persisted state or starting expensive processing.

### 4.2 Knowledge storage model

Knowledge uses a separate `KnowledgeEntry` store instead of mutating the existing realtime `knowledge-memory` schema. This keeps phase A-D changes from destabilizing the live prompt memory path.

SQLite is the application source of truth for listing, searching, editing, and authorization checks. JSONL remains the fallback when SQLite is unavailable. Markdown vault files are a readable and editable sidecar representation, not the runtime source of truth.

### 4.3 Trust boundary

HTTP clients are untrusted. They may choose user content, but they may not choose server executable paths, model paths, vault roots, or bypass request limits. Internal library calls may remain more flexible where they are used by trusted local code paths and tests.

### 4.4 Vault consistency model

CueMind must never overwrite externally edited vault files without detection. Vault sync therefore uses file hashes plus entry version checks. Conflicts are explicit states requiring user review or append-only merge behavior, depending on the operation.

### 4.5 Privacy model

Privacy review happens before remote send and before external export. Knowledge items and meeting artifacts may be:

- `clear`: safe for normal local save and remote send;
- `redacted`: stored or exported in redacted form;
- `privacy_uncertain`: local-only until user confirms;
- `blocked`: not allowed to leave the local boundary.

This state machine is additive. It does not weaken existing session access checks.

## 5. Implementation Sequence

Work proceeds in this order:

1. complete remaining security hardening and regression coverage;
2. complete knowledge phase B UI;
3. complete knowledge phase C vault sync and conflict handling;
4. complete knowledge phase D privacy and MCP read layer;
5. run production build and standalone verification across the combined surface.

The reason for this order is simple: phase B-D all depend on stable session authorization and bounded request behavior. Product UI before closing those boundaries would add more attack surface and more brittle test state.

## 6. Remaining Security Hardening Work

### 6.1 Uniform request body limits

Several routes still call `request.json()` before rejecting oversized bodies. Introduce a shared body-size gate at the HTTP boundary for routes such as:

- `app/api/ask/route.ts`
- `app/api/context-cards/route.ts`
- `app/api/local-memory/route.ts`
- `app/api/pipeline-events/route.ts`
- `app/api/vault-export/route.ts`

The contract is reject, not truncate. Oversized requests should fail with stable `400` or `413` responses before persistence or expensive downstream work.

### 6.2 Ask route boundaries

`/api/ask` still needs dedicated coverage and stricter field limits for:

- question length;
- context turns count;
- sources count;
- nested source field lengths;
- malformed or cross-session access attempts.

Regression coverage must include valid registered session access, missing token `401`, wrong token `401`, and oversize request `413`.

### 6.3 Context-card route boundaries

`/api/context-cards` still needs:

- dedicated session/token regression coverage;
- `cardContext` serialized-size limit;
- nested depth limit;
- explicit cross-session rejection checks.

This route already limits keywords and candidate arrays. The missing work is to close the remaining amplification surface in free-form card context payloads.

### 6.4 Pipeline event growth control

`app/api/pipeline-events/route.ts` and the related store layer still need:

- per-event metadata size limits;
- per-session cumulative file size or event count ceiling;
- explicit session ownership regression coverage.

This prevents timeline artifacts from becoming an unbounded per-session append sink.

### 6.5 Upload and transcript cumulative limits

Upload, transcription, and postmeeting routes should be checked as one group to ensure both per-request and per-session cumulative boundaries are explicit. The current route-level limits are improved, but not yet unified into one clear contract across media processing paths.

### 6.6 Standalone verification

After the route work is stable, run:

- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`

Then validate the standalone output for:

- `better-sqlite3` loading behavior;
- SQLite initialization in packaged output;
- JSONL fallback when SQLite is unavailable.

## 7. Phase A: Knowledge Entry Foundation

### Status

Completed.

### Delivered behavior

- Session-scoped knowledge entries with `active`, `archived`, and `deleted` states.
- List, search, detail, create, update, and soft-delete API behavior.
- Stable ID and slug generation.
- `cardId` origin validation.
- Optimistic locking with `version`.
- HTTP boundary limits for title, summary, content, aliases, and source arrays.

### Remaining follow-up tied to later phases

- Add archive and restore UX when phase B lands.
- Add vault-related fields only when phase C is implemented.
- Add privacy status fields only when phase D is implemented.

## 8. Phase B: Knowledge UI

### Goal

Add a dedicated `/knowledge` page so the knowledge base can be inspected and managed outside the main meeting surface, while still allowing fast deposit from context cards.

### Scope

- Create a standalone `/knowledge` page.
- Use a three-pane layout: search and filters, entry list, entry detail/editor.
- Support list, search, detail view, edit, archive, and delete actions.
- Show session-scoped results only.
- Reuse the current client session token pattern for all requests.
- Integrate context-card deposit so the user can confirm and minimally edit a card before saving it as a knowledge entry.

### UI behavior

The page should be a working management surface, not a marketing page. Expected baseline behavior:

- filter by status (`active`, `archived`);
- search by title, alias, summary, or content;
- open an entry and edit title, aliases, summary, and content;
- show source metadata and origin card/session references;
- optimistic-lock failure should surface a clear conflict state and force reload;
- deleted entries disappear from normal list views.

### Integration points

- `app/page.tsx`
- `components/ContextCardsPanel.tsx`
- `components/ContextCardView.tsx`
- existing session token helpers in `lib/client-session-auth.ts`

### Tests and acceptance

- UI/API regression for create, edit, archive/delete, and stale-version conflict.
- TypeScript and lint pass.
- One local commit for phase B after verification.

## 9. Phase C: Vault Sync and Conflict Detection

### Goal

Make knowledge entries exportable and maintainable in the markdown vault without turning vault files into the primary runtime store.

### Scope

- Export knowledge entries to a stable vault directory layout.
- Record file hash and last exported version for each knowledge entry.
- Detect external vault edits before overwrite.
- Mark conflicts instead of replacing external changes.
- Reuse the existing vault root restrictions and server-controlled path policy.

### Write model

For each entry, CueMind writes a corresponding markdown file under the configured vault root. The exported document should contain structured frontmatter describing:

- entry ID;
- slug;
- aliases;
- source types;
- origin sessions;
- last exported app version;
- file hash metadata as needed for conflict detection.

### Conflict rules

- If the vault file matches the last known exported hash and the app version is current, normal overwrite is allowed.
- If the file hash changed outside CueMind, mark the knowledge entry as conflicted and stop automatic overwrite.
- If only the app entry changed, CueMind may create a new exported revision.
- If both changed, prefer explicit conflict state over silent merge.

### Acceptance

- Re-export of an unchanged entry is idempotent.
- External file edits are detected deterministically.
- Vault root traversal remains impossible from HTTP input.
- Standalone build still works with `better-sqlite3` or JSONL fallback.
- One local commit for phase C after verification.

## 10. Phase D: Privacy and Read-Only MCP

### Goal

Add privacy-aware save/send behavior and expose the knowledge base through read-only MCP tools.

### Privacy scope

- Detect likely sensitive material before external export or remote send.
- Support `clear`, `redacted`, `privacy_uncertain`, and `blocked` outcomes.
- Redaction applies to exported or remote-facing copies, not to immutable raw session history.
- `privacy_uncertain` allows local persistence but blocks remote send until confirmation.
- `blocked` prevents external export and remote transmission.

### MCP scope

Add read-only knowledge retrieval tools only:

- `list_knowledge_entries`
- `get_knowledge_entry`
- `search_knowledge`
- `get_knowledge_versions`
- `get_knowledge_sources`

These tools must not mutate data, trigger sync, delete entries, or bypass session scope.

### Remote-send boundary

Any existing or future remote path must respect the privacy result before egress. Session authorization is necessary but not sufficient; privacy state becomes an additional allow/block gate for remote operations.

### Acceptance

- Sensitive content is never exported or sent remotely when classified as `blocked`.
- Redacted artifacts contain replacement metadata but not original sensitive values.
- MCP tools are read-only and scoped to allowed local knowledge data.
- One local commit for phase D after verification.

## 11. Testing and Verification Strategy

Each independent phase must leave behind the smallest useful proof that breaks when the contract regresses.

### Required validation per completed phase

- targeted `scripts/test-*.ts` regressions for touched routes or stores;
- `npx tsc --noEmit`;
- `npm run lint`;
- `git diff --check`;
- `npm run build` when the phase changes runtime packaging, native modules, or standalone behavior.

### Additional checks

- session auth regressions for any route that reads or mutates session-scoped state;
- explicit `401` assertions for missing or wrong tokens;
- explicit `409` assertions for optimistic-lock conflicts;
- explicit `413` assertions for oversized payloads;
- vault conflict regression for external file modification;
- MCP smoke tests proving read-only behavior and no write surface.

## 12. Commit Strategy

Every independently verifiable phase gets its own local git commit. Do not combine unrelated security and product changes just because they happen in the same time window.

Expected sequence from this point:

1. remaining security boundary and regression work;
2. phase B knowledge UI;
3. phase C vault sync and conflict detection;
4. phase D privacy and read-only MCP;
5. final production verification commit only if it contains actual code or doc changes.

Existing completed commits remain the audit trail for already-finished hardening and phase A work.

## 13. Risks and Guardrails

### Confirmed risks

- Routes that parse full JSON bodies before boundary checks still allow avoidable memory amplification.
- Pipeline event persistence can still grow without a clearly enforced per-session ceiling.
- Vault sync without conflict detection would overwrite external edits and break the local-first contract.

### Potential risks

- Standalone packaging may still behave differently when native SQLite loading fails.
- Knowledge UI could accidentally couple meeting-state assumptions into a standalone management surface.
- Privacy review may be bypassed by future egress paths unless it is implemented as a shared gate rather than a route-local heuristic.

### Guardrails

- Prefer route-layer enforcement over weakening lower-level libraries used by trusted local code.
- Reject oversized or unauthorized requests directly; do not silently trim data.
- Keep the vault as a sidecar representation, not the runtime source of truth.
- Keep MCP read-only.
- Do not revert unrelated user or generated workspace changes.

## 14. Definition of Done

This combined plan is done only when all of the following are true:

- Remaining security boundary gaps are closed and regression-tested.
- Knowledge phase B, C, and D are implemented according to the scoped contracts above.
- Session-scoped authorization remains intact across all knowledge and export surfaces.
- Vault exports are deterministic, conflict-aware, and bounded by the configured root.
- Privacy states gate remote/export behavior without mutating immutable raw records.
- Read-only MCP tools expose retrieval without adding write or sync capabilities.
- TypeScript, lint, focused regressions, and production build validation pass.
