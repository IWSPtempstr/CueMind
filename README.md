# TwinMind Live Suggestions

## What This Is

TwinMind Live Suggestions is a **meeting copilot**: three columns, one conversation, and a stubborn belief that the best nudge is the one that arrives *while you’re still in the sentence*, not five minutes later.

The product bet is simple: during a live call, people do not need more noise - they need the *right* suggestion at the *right* moment. This repo is my answer: live transcription on a fixed cadence, contextual suggestion batches every ~30 seconds, streaming chat grounded in the same transcript, runtime prompt/settings control from a modal, and one-click JSON session export.

---

## Getting Started

**Live demo:** https://twinmind-live-suggestions-jet.vercel.app

You need **Node 18+** and a **Groq API key**.
1. Clone the repo and install dependencies: `npm install`
2. Start the app: `npm run dev`
3. Open **Settings** (gear icon, top right) and paste your Groq API key
4. Click the mic and start talking
5. Transcript chunks and live suggestions refresh automatically every ~30s
6. Click any suggestion card to open it in chat (instant preview + streamed answer)
7. Use **Export Session** to download transcript + suggestions + chat as JSON

---

## Stack & Architecture

**Next.js 15 (App Router)** — I chose this because route handlers are a natural place to sit between the browser and Groq: the client never needs a hardcoded secret in the bundle, and a Vercel deploy is mostly “connect repo, set nothing exotic, go.” The App Router also keeps the UI and API colocated in a way that matches how I think about the product: pages compose panels; `/api/*` composes providers.

**Tailwind CSS** — No component library. I wanted speed and a dark, dense UI without fighting a design system I didn’t own. Tailwind let me iterate on spacing and borders until the three columns *felt* like a control room, not a slide deck.

**No database, no auth** — For this assignment, persistence would be a distraction. Everything interesting lives in **React state for the session**: recording, transcript chunks, suggestion batches, and chat messages. If you refresh, you’re starting a new mental session anyway—that matches how I’d use a copilot in a real meeting.

**Three Groq call families** — The architecture lines up like this:

1. **Whisper** (via Groq’s OpenAI-compatible transcription endpoint) for chunked speech-to-text.
2. **GPT-OSS 120B** for **summarization + live suggestions** — a small summarize hop, then structured suggestion batches in the middle column.
3. **GPT-OSS 120B** again for **chat**—longer answers when a suggestion isn’t enough.

Transcription, the suggestion pipeline (summarize + suggest), and streaming chat are all live against Groq.

---

## How the Transcription Works

The browser’s **MediaRecorder** runs on a **30 second stop/restart cycle** on the **same** `MediaStream`: I `start()` with **no timeslice**, let audio accumulate, then **`stop()`** so the recorder emits a **single, self-contained WebM/Opus blob** for that window. That blob goes to **`POST /api/transcribe`**, which forwards multipart data to Groq’s **Whisper Large V3** endpoint. Immediately after `onstop` (unless you’ve pressed stop for real), I spin up a **fresh** `MediaRecorder` on the same stream and `start()` again—rinse and repeat. I’m not re-encoding: Chrome/Firefox already give us WebM + Opus, and Whisper is fine with it.

**Why I walked away from timeslice.** With `start(timeslice)`, **`ondataavailable` only carries the full WebM container header in the first chunk**; later chunks are mostly codec deltas without a valid standalone header. Whisper quite reasonably **400**s those “orphan” blobs. You can try to glue the header onto every delta (I did for a while), but then Whisper happily **re-transcribes the same opening audio** on every request—duplicate transcript hell. The stop/restart pattern sidesteps both problems: each upload is a real file.

**The honest cost: a small gap.** Stopping the recorder, finalizing the blob, POSTing, and starting again isn’t free in wall-clock time. In practice I see on the order of **~1–2 seconds of dead air per ~30 second cycle**—call it **roughly 6% of the timeline** if you’re feeling statistical. That’s a deliberate tradeoff: **I’d rather lose a sliver of continuity than ship garbage audio or duplicate text.** If that gap ever matters for a productized version, the next levers are overlapping recorders or a native pipeline—not going back to naive timeslice uploads.

**Tiny blobs still happen.** The tail of a segment can still be effectively empty. On the client I **skip the transcribe call** if the finalized blob is under **1KB**; on the server **`/api/transcribe`** still returns **`{ text: "" }` with 200** for sub-1KB uploads so Groq never sees noise. Same spirit as before, updated for “one blob per segment” instead of “every timeslice tick.”

---

## Prompt Strategy

**Context windowing — two layers.** I split context into a **recent** verbatim tail and an **earlier** region. Recent is about **3,000 chars** (~last 3 minutes), because that is what people are reacting to right now. Earlier is up to **4,000 chars** from the end of the older transcript so background stays fresh. The cost is that this is character-window based, not speaker-turn aware, which is simpler and fast but can cut conversational boundaries.

**Why summarize instead of truncate.** I summarize the earlier slice before suggestion generation because truncation destroys context at sentence and entity boundaries. A short 3-5 sentence summary keeps decisions, names, numbers, and commitments coherent enough for the model to reason on. That gives better signal than shoving a broken raw chunk into the prompt. The cost is that summarization is lossy by design.

**The two-call latency tradeoff.** Suggestion refresh is sequential: first `/api/summarize`, then `/api/suggestions`. I accept that because the summary is capped at **200 tokens**, so the added latency is usually tens to low hundreds of milliseconds, while quality gains are obvious in longer meetings. This keeps the suggestion model focused instead of context-confused. The cost is one extra network/model hop per refresh.

**Suggestion types — five labels, not a bingo card.** I use five labels (`question`, `talking_point`, `answer`, `fact_check`, `clarify`) as vocabulary, not quotas. The prompt explicitly forbids one-of-each output and asks for the three best fits for the current moment. That keeps batches useful instead of formulaic—type distribution is intentionally uneven across refreshes.

**JSON Schema mode.** Suggestions run in structured-output mode with a strict schema: exactly three items, each with `type`, `preview`, and `detail`. That gives me stable UI contracts and avoids regex cleanup or brittle post-processing. I still validate at the route boundary, but schema-first keeps the wire format predictable. The risk is that strict schema can reject otherwise reasonable free-form output.

**Previous suggestions in the loop.** Each refresh includes the last batch previews as anti-repeat context. That simple addition noticeably reduces duplicate nudges when conversation stalls or loops. It is cheap, explicit, and model-friendly. The risk is that if previous suggestions were wrong, they still influence the next pass.

**Chat — transcript as ground truth, answers kept tight.** Chat always receives the meeting transcript as a separate system block, distinct from instruction text. That keeps answers anchored to what was actually said — the model can infer and synthesize, but it is not invited to invent missing meeting facts. The chat prompt also enforces conciseness explicitly: 3-5 sentences for most questions, lead with the answer, no preamble. A model this capable will happily write paragraphs when asked nothing — the prompt is what keeps it useful in a live meeting context rather than impressive in a vacuum.

**Instant detail preview + streaming.** Clicking a suggestion inserts its `detail` immediately, then streams a fuller answer underneath. This makes interaction feel responsive in live-call conditions where dead time kills trust. Users get immediate value plus richer follow-up without waiting on full completion—users may read the preview as final before the stream finishes.

**Prompt tuning results.** After testing across multiple real sessions — a classroom discussion on silence and poetry, a talk on the butterfly effect, and a full Dan Pink TED talk on motivation — the prompt strategy held up well. Fact checks fired on specific quantitative claims (Glucksberg's 3.5-minute incentive condition slowdown, the origin of the candle problem). Clarify suggestions caught newly introduced terms like 'functional fixedness' at exactly the right moment. Type distribution stayed varied across all 9 batches of the motivation session without feeling formulaic. No structural prompt changes were needed after live testing — the five-type vocabulary, the anti-repeat context, and the two-layer windowing held up across different conversation styles.

---

## Tradeoffs & Decisions

**We skip audio conversion** because WebM/Opus is already what Whisper accepts in practice, and every conversion step adds latency and failure modes. This keeps the transcription path short and debuggable. If mobile Safari constraints force a format bridge later, I will add it with clear justification.

**The Groq key lives in `localStorage`** for this assignment because account systems and vault management are outside scope. The key is not committed and not hardcoded server-side; it is provided by the user in Settings and forwarded per request header. That is a pragmatic local-dev security posture, not an enterprise auth model.

**All state in React** keeps the mental model small: one session, one tab, one source of truth. This avoids persistence complexity, migrations, and sync bugs for a workflow that is naturally session-oriented. The cost is explicit: refresh resets runtime state, which is acceptable for this scope.

**Stop/restart transcription vs MediaRecorder timeslice.** Timeslice produced non-standalone chunks that Whisper rejected (or duplicated when header-glued). Stop/restart gives one valid WebM per segment and removes duplicate transcript failure modes. The cost is a small **~1-2s** gap per **~30s** cycle (~6% timeline).

**Two Groq calls per suggestion refresh (summarize, then suggest).** The summarize hop buys coherent earlier context without flooding the suggestion prompt with raw transcript. Sequential latency is real, but bounded because the summary output is capped at 200 tokens. If latency becomes the top bottleneck, collapsing into one call is the straightforward optimization.

**Streaming chat responses.** Chat uses SSE so first token latency is typically **~200-400ms** instead of waiting several seconds for full completion. In a live meeting, that response shape materially improves usability. Tradeoff: stream parsing/state handling is more complex than one-shot JSON.

**Manual refresh flushes pending audio first.** The spec requires the reload button to update the transcript before generating suggestions. We implement this by calling `flushCurrentChunk()` — which stops the current recorder segment early and lets `onstop` transcribe it — then firing suggestion generation 500ms later. The gap is a pragmatic head start, not a guaranteed await; on slow networks suggestions can occasionally fire before the final transcript chunk lands. The tradeoff is simplicity over perfect sequencing.

**System audio capture — attempted and removed.** We explored adding getDisplayMedia-based system audio capture so both sides of a virtual meeting could be transcribed. The implementation mixed mic and tab audio via Web Audio API's AudioContext into a single MediaRecorder stream. It proved unreliable on macOS Chrome due to how WebRTC audio is routed internally in tools like Google Meet — tab audio capture does not intercept WebRTC streams. Rather than ship a feature that works inconsistently, we removed it. The mic-only path is reliable and sufficient for the intended use case: during a live interview, the interviewer's questions provide enough spoken context for the suggestion engine to generate useful nudges from the speaker's side alone.

**Chat history limit (20 turns).** I cap chat history at 20 turns and rely on transcript context as long-term memory. That keeps prompt size controlled without adding another summarization hop before every chat request. Tradeoff: very long side-thread nuance can fall out of chat history while transcript grounding remains.

**Settings and prompt customization.** Prompts and context windows are editable at runtime in Settings, then sent on each request body. Routes prefer request values and fall back to `lib/prompts.ts` defaults, so reset behavior is deterministic. Tradeoff: prompt quality can degrade if users enter poor instructions, which is expected by design.

## Known Limitations & Future Work

### One-sided transcription in virtual meetings
The app captures microphone input only. In an in-person meeting this works well — the mic picks up everyone in the room. In a virtual meeting (Zoom, Google Meet), only the local speaker's voice is captured; the remote participant's audio comes through speakers but isn't reliably transcribed.

We explored getDisplayMedia-based tab audio capture to mix both mic and system audio into a single MediaRecorder stream via the Web Audio API's AudioContext. It works for standard browser tab audio (YouTube, etc.) but fails for virtual meeting tools like Google Meet because WebRTC routes received audio through a separate internal pipeline that tab capture doesn't intercept. This is a known platform-level limitation, not a code bug.

How TwinMind solves this in their product: their mobile app runs on-device with their Ear-3 ASR model and physically captures room audio — the phone mic hears both the local speaker and the remote participant's voice coming through laptop speakers. Their planned native desktop app will have system-level audio access that browsers fundamentally cannot provide. Both approaches require leaving the browser sandbox entirely.

The practical workaround for virtual interviews: the suggestion engine generates useful nudges from the speaker's side alone. Narrating or paraphrasing what the other person says ("so you're asking about X...") feeds their context into the transcript naturally.

### No speaker diarization
The app transcribes speech as a single stream without identifying who said what. TwinMind's Ear-3 model achieves a 3.8% Speaker Diarization Error Rate — world-class performance that comes from a dedicated pipeline: voice activity detection, speaker embedding extraction (pitch, tone, cadence fingerprinting), and clustering to label segments by speaker.

Whisper Large V3 does not perform diarization — it transcribes only. Adding diarization would require either a separate diarization API (AssemblyAI, Deepgram, or Pyannote) or TwinMind's own Ear-3 API (which they've announced plans to open). It also conflicts architecturally with our real-time 30s chunk approach since diarization typically needs a complete audio segment to accurately cluster speakers. It's a meaningful pipeline change, not a drop-in add-on.

---

## Responsiveness & Accessibility

The layout is desktop-first by design — a meeting copilot lives on the same screen as your video call, not on a phone. On large screens (1024px+) you get the full three-column experience. Below that, the columns stack vertically, each taking full width and 50vh of height with independent scroll, so the app remains usable on smaller displays without the layout collapsing.

On the accessibility side: the mic button carries `aria-label` and `aria-pressed` so screen readers announce recording state. Suggestion cards are fully keyboard navigable with Enter/Space activation. The chat message list has `aria-live="polite"` so new messages are announced. The settings modal traps focus when open and auto-focuses the API key field. All icon-only buttons have explicit `aria-label` attributes.

