# CueMind Desktop MVP

## Product Goal

CueMind Desktop is a Windows meeting cognition assistant. It listens to default system audio and default microphone audio locally, transcribes both tracks with local ASR, detects technical keywords, searches the web for supporting context, and renders short Chinese explanation cards before the meeting topic window closes.

## Privacy Boundary

- Raw audio stays on the local machine.
- Local transcripts stay on the local machine unless the user exports them.
- Keywords or short search queries are sent to the configured web search provider.
- Card generation uses local Ollama by default.
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
| 2026-08-21 | WSL2 | Context-card route validation smoke | Pass: invalid body returns 400; unavailable Ollama returns structured `{ card: null, failure }` | `app/api/context-cards` |
| 2026-08-21 | WSL2 | Real Ollama + web-source card | Pending: local Ollama endpoint/model and search API key not configured |  |
| 2026-08-21 | WSL2 | Latency telemetry + replay parser | Pass: TypeScript/lint/build, percentile smoke, 3-event fixture parse | `lib/telemetry.ts`, `lib/replay.ts` |
| 2026-08-21 | WSL2 | `.NET helper build` | Blocked: `dotnet` not installed in WSL | local terminal |
| 2026-08-21 | Windows 10/11 x64 | Dual-track capture | Pending |  |
| 2026-08-21 | Windows 10/11 x64 | Local ASR tiny/base WAV smoke | Pending: requires whisper.cpp executable and model on Windows |  |
| 2026-08-21 | Windows 10/11 x64 | 10-minute replay demo | Pending |  |

## Resume Bullet Draft

Built a Windows desktop realtime meeting cognition assistant by extending a Next.js meeting copilot with Electron, C#/.NET WASAPI dual-track audio capture, local whisper.cpp transcription, local Ollama keyword/card generation, web-search grounding, replay mode, and stage-level latency telemetry; target demo is a 10-minute technical meeting with 3-5 sourced Chinese context cards under a P50 <= 8s / P95 <= 15s card-latency budget.

## Interview Explanation Outline

1. Problem: people miss technical context during live meetings, and post-meeting summaries arrive too late.
2. Constraint: meeting audio should not be uploaded; browser capture cannot reliably get remote meeting audio.
3. Architecture: desktop helper captures system and microphone audio separately, local ASR transcribes both, local LLM extracts keywords, search grounds explanations, UI renders short cards.
4. Engineering tradeoff: dual-track capture costs more ASR work but improves attribution, debugging, and telemetry.
5. Reliability: search retries once, source-insufficient cards are skipped, replay mode reproduces failures.
6. Metrics: stage-level latency makes the project measurable rather than a vague AI demo.
