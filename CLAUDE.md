# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # install dependencies (Node >= 18.18.0)
npm run dev       # dev server with Turbopack (http://localhost:3000)
npm run build     # production build — the primary correctness gate (runs full type-check)
npm run start     # serve the production build (add `-- -p <port>` to change port)
npm run lint      # eslint (flat config, next/core-web-vitals + next/typescript)
npx tsc --noEmit  # standalone type-check
```

There is **no test suite** in this project. The verification loop is: `npx tsc --noEmit` → `npm run lint` → `npm run build`. `npm run build` is the real gate because it type-checks every route and page under production settings.

## Big-picture architecture

**CueMind** is a single-page **meeting copilot** (Next.js 15 App Router, React 19, Tailwind v4, no database, no auth). One client shell orchestrates three columns; four API routes are thin server-side proxies to **Groq** (OpenAI-compatible endpoints). All live state lives in React; recent sessions autosave to `localStorage`.

**The client owns everything; routes are stateless proxies.** [app/page.tsx](app/page.tsx) is the only page. It composes three hooks — `useMicRecorder`, `useSuggestions`, `useChat` — and passes their state down to the three column components ([MicTranscript](components/MicTranscript.tsx), [LiveSuggestions](components/LiveSuggestions.tsx), [ChatPanel](components/ChatPanel.tsx)). The hooks are the source of truth; components are presentational. To understand any feature, start at the hook, not the component.

**The transcription pipeline is the subtle part.** [hooks/useMicRecorder.ts](hooks/useMicRecorder.ts) runs **overlapping `MediaRecorder` segments** on one `MediaStream`: recorder B starts ~1s before recorder A stops (`RECORDER_OVERLAP_MS`), so each ~30s window produces a *self-contained* WebM/Opus blob with a valid header while covering the rollover seam. This deliberately avoids `MediaRecorder` timeslice, which yields headerless "orphan" chunks Whisper rejects. Blobs under 1KB or below the silence RMS threshold are skipped client-side; each blob POSTs to `/api/transcribe`. Failed uploads are **retried with exponential backoff** (audio is never dropped). `flushCurrentChunk()` (manual refresh) stops all recording segments early and starts a fresh one. Read the README's "How the Transcription Works" before touching this file — the design rationale matters.

**The suggestion refresh is a two-call sequence.** [hooks/useSuggestions.ts](hooks/useSuggestions.ts) `runCycle()` first POSTs the older transcript slice to `/api/summarize`, then POSTs `{ recentTranscript, earlierSummary, previousSuggestions }` to `/api/suggestions`. Context is split into a recent verbatim tail + a summarized earlier region (see `buildContextStrings`). Suggestions use Groq **JSON-schema structured output** (exactly 3 items, each `{ type, preview, detail }`) — validated at the route boundary. Previous + dismissed previews are fed back as anti-repeat context.

**Chat streams via SSE.** [hooks/useChat.ts](hooks/useChat.ts) POSTs to `/api/chat` with `stream: true` and parses SSE frames manually (buffering on `\n\n` boundaries). Clicking a suggestion inserts its `detail` instantly, then streams a fuller answer. Supports mid-stream abort (`AbortController`) and retry of the last failed prompt.

**Session model.** [types/session.ts](types/session.ts) `SessionSnapshot` is the serializable unit for both autosave ([lib/session-storage.ts](lib/session-storage.ts), last 10 sessions) and export ([lib/export.ts](lib/export.ts), JSON or Markdown). Because `Date` fields don't survive JSON, both load paths **explicitly revive** them — preserve that when adding fields.

## Conventions that will bite you if missed

- **`@/*` path alias** maps to the repo root (see `tsconfig.json` paths). Import as `@/hooks/...`, `@/lib/...`.
- **All browser storage is namespaced `cuemind_*`** (`cuemind_settings`, `cuemind_groq_api_key` / `cuemind_session_groq_api_key`, `cuemind_sessions_v1`); exports use `cuemind-session-*` filenames. Only `groq_api_key` (unprefixed) is a recognized legacy key the settings loader migrates. Renaming any of these keys orphans existing users' saved data — treat them as a stable contract.
- **Prompts, models, and all caps/limits live in [lib/prompts.ts](lib/prompts.ts).** Models are `whisper-large-v3` for transcription and `openai/gpt-oss-120b` for everything else. Don't hardcode these elsewhere — add a constant here.
- **API-route security is centralized in [lib/api-security.ts](lib/api-security.ts)** and applied uniformly: every route calls `enforceRateLimit(request, bucket, limit)`, resolves the key via `resolveGroqApiKey` (custom `x-groq-api-key` header → `GROQ_API_KEY` env fallback), and clamps request-body inputs with `cappedText`/`cappedPrompt` against the `MAX_*` constants in `lib/prompts.ts`. Any new route must follow this same shape. The rate limiter is a per-instance safety net, not a distributed limiter.
- **Never trust client-supplied sizes.** Context/prompt/message lengths are clamped server-side to `MAX_*` ceilings regardless of what the client sends; transcript content is wrapped in `<meeting_transcript>` delimiters and labeled as untrusted data (prompt-injection hardening). Keep both.
- **The Groq key never appears in the preferences blob.** [hooks/useSettings.ts](hooks/useSettings.ts) stores the secret separately (localStorage / sessionStorage / in-memory per `apiKeyStorage` mode) and strips it from `cuemind_settings`. `loadCueMindSettings()` runs a **one-time** legacy-key migration and otherwise does not write storage on every call — don't reintroduce per-load writes.
- **Security headers** (CSP, X-Frame-Options, etc.) are set in [next.config.ts](next.config.ts) `headers()`; `connect-src 'self'` means the browser only talks to same-origin `/api/*`, never Groq directly.
- **Route response helpers**: use `groqApiErrorMessage` / `extractGroqChatAssistantContent` ([lib/groq-route-helpers.ts](lib/groq-route-helpers.ts)) and the `isErrorResponseBody` guard ([lib/api-response.ts](lib/api-response.ts)) rather than re-parsing Groq/error envelopes inline.

## Known constraint

Audio capture is **microphone-only**. Browser sandboxing prevents capturing the remote participant's voice in virtual meetings (WebRTC audio is not reachable via tab capture). This is a platform limitation, not a bug — see the README's "Known Limitations & Future Work". A native desktop shell (Electron loopback audio) is the documented path to two-way capture.
