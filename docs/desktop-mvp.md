# CueMind Desktop MVP

## Product Goal

CueMind Desktop is a Windows meeting cognition assistant. It listens to default system audio and default microphone audio locally, transcribes both tracks with local ASR, detects technical keywords, searches the web for supporting context, and renders short Chinese explanation cards before the meeting topic window closes.

## Privacy Boundary

- Raw audio stays on the local machine.
- Local transcripts stay on the local machine unless the user exports them.
- Keywords or short search queries are sent to the configured web search provider.
- Card generation uses local llama.cpp by default; an explicitly configured OpenAI-compatible remote API is available as an alternative.
- The app must label itself as local inference with web-search enhancement, not fully offline.

## MVP Acceptance Demo

- Input: one 10-minute technical meeting recording.
- Content: 8-12 AI or engineering terms.
- Output: 3-5 cards with two source links each.
- Metrics: ASR latency, keyword latency, search latency, card-generation latency, UI-render latency, total latency.
- Target: card total latency P50 <= 8s and P95 <= 15s.

## Non-Goals

- Speaker diarization.
- Per-application audio capture.
- Enterprise deployment controls.
- Offline RAG knowledge base.
- Production auto-update.

## Evidence Log

| Date | Host | Check | Result | Artifact |
| --- | --- | --- | --- | --- |
| 2026-08-21 | WSL2 | `npx tsc --noEmit` | Pass | local terminal |
| 2026-08-21 | WSL2 | `npm run lint` | Pass | local terminal |
| 2026-08-21 | WSL2 | `npm run build` | Pass | local terminal |
| 2026-08-21 | WSL2 | Electron shell TypeScript/lint | Pass | `desktop/electron/*` |
| 2026-08-21 | WSL2 | `npm run desktop:dev` | Blocked before Electron launch: npm Electron binary download did not complete within bounded probe; Next dev server returned HTTP 200 | local terminal |
| 2026-08-21 | WSL2 | Local ASR route TypeScript/lint/build | Pass | `app/api/local-transcribe`, `lib/local-asr.ts` |
| 2026-08-25 | WSL2 | Real whisper.cpp Small 30-second Chinese WAV smoke through project adapter | Pass: `whisper.cpp 1.9.3-dev` CPU/OpenMP, `ggml-small.bin`, 30,000 ms audio, 10,265 ms adapter latency, RTF 0.3422, timestamped JSON output | `scripts/run-local-asr-smoke.ts`; runtime report kept outside repository |
| 2026-08-21 | WSL2 | Context-card route validation smoke | Pass: invalid body returns 400; unavailable llama.cpp returns structured `{ card: null, failure }` | `app/api/context-cards` |
| 2026-08-21 | WSL2 | Real llama.cpp + web-source card | Pending: local llama.cpp endpoint/model and search API key not configured |  |
| 2026-08-21 | WSL2 | Latency telemetry + replay parser | Pass: TypeScript/lint/build, percentile smoke, 3-event fixture parse | `lib/telemetry.ts`, `lib/replay.ts` |
| 2026-08-21 | WSL2 | Chinese UX + Next standalone preparation | Pass: TypeScript/lint/build; `.next/standalone/server.js` and static assets prepared | `desktop/prepare-standalone.mjs` |
| 2026-08-21 | WSL2 | Electron main/preload compilation | Pass: `desktop/electron/dist/main.js`, `preload.js` generated | `npm run desktop:compile` |
| 2026-08-21 | WSL2 | `.NET helper build` | Blocked: `dotnet` not installed in WSL | local terminal |
| 2026-08-21 | WSL2 | NSIS packaging | Blocked before builder: Windows helper publish and Electron binary cache are unavailable in WSL | `npm run helper:build` |
| 2026-08-21 | Windows 10/11 x64 | Dual-track capture | Pending |  |
| 2026-08-21 | Windows 10/11 x64 | Local ASR tiny/base WAV smoke | Pending: requires whisper.cpp executable and model on Windows |  |
| 2026-08-21 | Windows 10/11 x64 | Real llama.cpp + two-source card | Pending: requires llama.cpp model and search API key |  |
| 2026-08-21 | Windows 10/11 x64 | 10-minute replay demo | Pending |  |

## Implementation Status

Implemented and locally verified:

- Electron shell with isolated preload bridge and helper lifecycle IPC.
- Windows NAudio helper source with separate system and microphone tracks.
- Local whisper.cpp process adapter and desktop transcript event path.
- llama.cpp JSON generation, Tavily/Bing/SerpAPI adapters, one retry for insufficient sources, and structured card failures.
- Automatic context-card cooldown/deduplication, source links, and debug failure rows.
- Stage latency samples, P50/P95 panel, JSONL replay parser/page, and a synthetic fixture.
- Chinese-first desktop controls and Next standalone packaging preparation.

Externally unverified:

- Windows WASAPI device capture and helper compilation.
- Windows whisper.cpp executable/model transcription and long-video stability.
- The WSL CPU Small-model smoke is verified only on a single 30-second clip and is not a general Chinese accuracy benchmark.
- Real llama.cpp generation and web search with two usable sources.
- NSIS installation, packaged startup, and the 10-minute acceptance run.

## Resume Bullet Draft

Built a Windows desktop realtime meeting cognition assistant by extending a Next.js meeting copilot with Electron, C#/.NET WASAPI dual-track audio capture, local whisper.cpp transcription, local llama.cpp keyword/card generation, web-search grounding, replay mode, and stage-level latency telemetry; target demo is a 10-minute technical meeting with 3-5 sourced Chinese context cards under a P50 <= 8s / P95 <= 15s card-latency budget.

## Interview Explanation Outline

1. Problem: people miss technical context during live meetings, and post-meeting summaries arrive too late.
2. Constraint: meeting audio should not be uploaded; browser capture cannot reliably get remote meeting audio.
3. Architecture: desktop helper captures system and microphone audio separately, local ASR transcribes both, local LLM extracts keywords, search grounds explanations, UI renders short cards.
4. Engineering tradeoff: dual-track capture costs more ASR work but improves attribution, debugging, and telemetry.
5. Reliability: search retries once, source-insufficient cards are skipped, replay mode reproduces failures.
6. Metrics: stage-level latency makes the project measurable rather than a vague AI demo.
