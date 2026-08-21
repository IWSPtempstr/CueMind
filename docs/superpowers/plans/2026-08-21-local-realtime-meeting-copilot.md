# Local Realtime Meeting Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert CueMind from a browser mic + Groq meeting copilot into a Windows desktop realtime meeting cognition assistant with dual-track local audio capture, local ASR, local LLM keyword cards, web-search grounding, latency telemetry, and replay mode.

**Architecture:** Keep the current Next.js UI and hook-first structure, then wrap it with Electron for desktop delivery. Add a C#/.NET NAudio helper for Windows WASAPI Loopback + microphone capture, a local `whisper.cpp` transcription adapter, an Ollama card-generation adapter, a search-grounded keyword-card pipeline, and a replay harness that can reproduce a 10-minute demo run.

**Tech Stack:** Next.js 15, React 19, TypeScript, Electron, electron-builder NSIS, C#/.NET 8, NAudio, whisper.cpp, Ollama, a configurable web search API, local JSONL event logs.

---

## Locked Product Decisions

- Target product: Windows desktop realtime meeting assistant.
- Capture scope: default Windows playback device system audio plus default microphone.
- Audio track model: two independent tracks, `system` and `microphone`, separately timestamped and merged later.
- Native capture route: C#/.NET helper process using NAudio and WASAPI Loopback.
- Supported OS: Windows 10 22H2 and Windows 11 x64.
- Packaging: NSIS installer that bundles the desktop shell and helper.
- ASR: local `whisper.cpp`.
- First ASR model size: `tiny` or `base`, optimized for latency and packaging simplicity.
- Keyword/card LLM: local Ollama with a Chinese-friendly 3B/7B model.
- Retrieval: generic web search API.
- Card triggering: automatic when a new high-confidence technical keyword appears.
- Card latency budget: P50 <= 8s, P95 <= 15s, minimum 20s between generated cards.
- Card content: keyword, one-sentence explanation, why it matters now, and two source links.
- Retrieval failure: retry once, then skip card and record failure reason.
- Replay mode: required in MVP.
- Demo acceptance scenario: 10-minute technical meeting recording, 8-12 AI/engineering terms, 3-5 sourced cards, latency breakdown.

## Current Codebase Facts

- Current app is a Next.js 15 App Router web app with one page at `app/page.tsx`.
- Current capture is browser-only microphone recording in `hooks/useMicRecorder.ts` using `navigator.mediaDevices.getUserMedia({ audio: true })` and overlapping `MediaRecorder` WebM/Opus blobs.
- Current transcription endpoint is `app/api/transcribe/route.ts`, which accepts WebM and proxies to Groq Whisper.
- Current suggestion pipeline is `hooks/useSuggestions.ts` -> `/api/summarize` -> `/api/suggestions`, both using Groq and schema-style structured suggestions.
- Current `TranscriptChunk` only has `id`, `text`, and `timestamp`; it lacks `source`, `startMs`, `endMs`, confidence, and latency fields.
- Current README explicitly says system audio capture was removed because browser tab/audio capture was unreliable for virtual meetings. The desktop helper is the intended path around that limitation.

## File Structure To Create Or Modify

- Create `docs/desktop-mvp.md`: user-facing project scope, setup, demo script, and evidence checklist.
- Create `desktop/electron/main.ts`: Electron main process, starts Next UI and manages helper processes.
- Create `desktop/electron/preload.ts`: safe renderer bridge for desktop status and local runtime events.
- Create `desktop/electron/types.ts`: desktop IPC/event contracts.
- Modify `package.json`: add Electron, builder, desktop dev/build scripts, and local runtime scripts.
- Modify `next.config.ts`: support desktop packaging constraints when needed.
- Create `native/CueMind.Audio/CueMind.Audio.csproj`: .NET helper project.
- Create `native/CueMind.Audio/Program.cs`: helper CLI entrypoint.
- Create `native/CueMind.Audio/AudioCaptureService.cs`: NAudio system/microphone capture.
- Create `native/CueMind.Audio/JsonlEventWriter.cs`: writes audio metadata and chunk events as JSONL.
- Create `native/CueMind.Audio/README.md`: helper build/run/debug instructions.
- Create `lib/desktop-events.ts`: shared event parser and runtime validation for desktop/replay events.
- Modify `types/session.ts`: add transcript source and timing metadata.
- Create `lib/local-asr.ts`: TypeScript adapter for invoking local `whisper.cpp`.
- Create `app/api/local-transcribe/route.ts`: local ASR route used by the desktop pipeline.
- Create `lib/ollama.ts`: local Ollama structured generation adapter.
- Create `lib/search.ts`: generic search provider adapter with timeouts and one retry.
- Create `app/api/context-cards/route.ts`: keyword extraction, search, validation, retry, and card generation route.
- Modify `types/suggestions.ts`: add `ContextCard` and card failure types.
- Create `hooks/useDesktopTranscript.ts`: consumes desktop local events instead of browser `MediaRecorder`.
- Create `hooks/useContextCards.ts`: incremental automatic card trigger pipeline.
- Modify `components/LiveSuggestions.tsx`: display context cards and failure states.
- Modify `components/SuggestionCard.tsx`: support sourced context-card layout.
- Modify `components/SettingsModal.tsx`: add local runtime paths, model selection, search API key, and privacy labels.
- Create `lib/telemetry.ts`: latency marks and summary calculations.
- Create `components/LatencyPanel.tsx`: show ASR, keyword, search, LLM, render, and total latency.
- Create `lib/replay.ts`: read and play JSONL events with original or accelerated timing.
- Create `app/replay/page.tsx`: replay-mode UI and controls.
- Create `fixtures/demo-meeting/README.md`: demo recording requirements and prompt list.
- Create `fixtures/demo-meeting/sample-events.jsonl`: small synthetic event fixture for local development.

## MVP Boundaries

In scope for week one:

- Windows desktop shell launches the existing UI.
- Helper captures two tracks from default system audio and default microphone.
- Audio chunks are timestamped and sent to local ASR.
- `whisper.cpp` produces transcript chunks tagged as `system` or `microphone`.
- Transcript chunks are merged chronologically in the existing transcript panel.
- Local Ollama extracts candidate technical keywords and generates Chinese cards.
- Web search returns two source links per accepted card.
- Cards are rate-limited and deduplicated.
- Telemetry records ASR, keyword, search, LLM, render, and end-to-end latency.
- Replay mode can reproduce a demo run from JSONL events.
- Demo report shows 3-5 sourced cards from a 10-minute technical meeting recording.

Out of scope for week one:

- Speaker diarization.
- Per-application/process audio isolation.
- GPU-optimized ASR packaging.
- Offline knowledge base/RAG.
- Multi-language UI beyond Chinese-first labels.
- Production-grade auto-update.
- Enterprise policy controls.

## Task 1: Baseline And Branch Hygiene

**Files:**
- Read: `CLAUDE.md`
- Read: `README.md`
- Read: `package.json`
- Read: `hooks/useMicRecorder.ts`
- Read: `hooks/useSuggestions.ts`
- Read: `app/api/transcribe/route.ts`
- Read: `types/session.ts`

- [ ] **Step 1: Verify repository state**

Run:

```bash
cd /home/work/asr/CueMind
git status --short --branch
```

Expected: current branch is visible and unrelated user changes are identified before editing.

- [ ] **Step 2: Verify current correctness gate before changes**

Run:

```bash
cd /home/work/asr/CueMind
npx tsc --noEmit
npm run lint
npm run build
```

Expected: record pass/fail status. If baseline fails, document the failure in `docs/desktop-mvp.md` before making feature changes.

- [ ] **Step 3: Create a feature branch**

Run:

```bash
cd /home/work/asr/CueMind
git switch -c codex/local-realtime-meeting-copilot
```

Expected: branch switches to `codex/local-realtime-meeting-copilot`.

## Task 2: Document MVP Contract

**Files:**
- Create: `docs/desktop-mvp.md`
- Modify: `README.md`

- [ ] **Step 1: Create the MVP scope document**

Create `docs/desktop-mvp.md` with this structure:

```markdown
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
```

- [ ] **Step 2: Update README with desktop note**

Add a short section near `Known Limitations & Future Work`:

```markdown
### Desktop MVP direction

The desktop MVP moves beyond browser microphone capture by using a Windows helper process for default system audio plus microphone capture. The planned stack is Electron + C#/.NET NAudio + local whisper.cpp + local Ollama + web-search-grounded context cards. See `docs/desktop-mvp.md` for the implementation contract and evidence checklist.
```

- [ ] **Step 3: Verify documentation scope**

Run:

```bash
cd /home/work/asr/CueMind
git diff -- README.md docs/desktop-mvp.md
git diff --check
```

Expected: only documentation changes and no whitespace errors.

- [ ] **Step 4: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add README.md docs/desktop-mvp.md
git commit -m "docs: define desktop mvp contract"
```

## Task 3: Extend Shared Data Contracts

**Files:**
- Modify: `types/session.ts`
- Modify: `types/suggestions.ts`
- Create: `lib/desktop-events.ts`

- [ ] **Step 1: Extend transcript types**

Modify `types/session.ts` so `TranscriptChunk` supports dual-track and latency metadata:

```ts
export type AudioSource = "system" | "microphone";

export interface LatencyTrace {
  captureStartedAt?: Date;
  captureEndedAt?: Date;
  asrStartedAt?: Date;
  asrEndedAt?: Date;
  keywordStartedAt?: Date;
  keywordEndedAt?: Date;
  searchStartedAt?: Date;
  searchEndedAt?: Date;
  cardStartedAt?: Date;
  cardEndedAt?: Date;
  renderedAt?: Date;
}

export interface TranscriptChunk {
  id: string;
  text: string;
  timestamp: Date;
  source?: AudioSource;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  latency?: LatencyTrace;
}
```

- [ ] **Step 2: Add context-card types**

Modify `types/suggestions.ts`:

```ts
export interface ContextCardSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ContextCard {
  id: string;
  keyword: string;
  explanation: string;
  whyNow: string;
  sources: [ContextCardSource, ContextCardSource];
  createdAt: Date;
  transcriptChunkIds: string[];
  latencyMs: {
    keyword: number;
    search: number;
    generation: number;
    total: number;
  };
}

export interface ContextCardFailure {
  id: string;
  keyword: string;
  reason: string;
  failedAt: Date;
  transcriptChunkIds: string[];
}
```

- [ ] **Step 3: Create desktop event parser**

Create `lib/desktop-events.ts`:

```ts
import type { AudioSource } from "@/types/session";

export type DesktopEvent = AudioChunkReadyEvent | TranscriptReadyEvent | RuntimeErrorEvent;

export interface AudioChunkReadyEvent {
  type: "audio_chunk_ready";
  id: string;
  source: AudioSource;
  path: string;
  startedAt: string;
  endedAt: string;
  startMs: number;
  endMs: number;
  sampleRate: number;
  channels: number;
}

export interface TranscriptReadyEvent {
  type: "transcript_ready";
  id: string;
  audioChunkId: string;
  source: AudioSource;
  text: string;
  timestamp: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  latencyMs?: number;
}

export interface RuntimeErrorEvent {
  type: "runtime_error";
  code: string;
  message: string;
  occurredAt: string;
}

export function parseDesktopEvent(raw: string): DesktopEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
  const event = parsed as Record<string, unknown>;
  if (event.type === "audio_chunk_ready" && isAudioSource(event.source) && isString(event.id) && isString(event.path)) {
    return event as unknown as AudioChunkReadyEvent;
  }
  if (event.type === "transcript_ready" && isAudioSource(event.source) && isString(event.id) && isString(event.text)) {
    return event as unknown as TranscriptReadyEvent;
  }
  if (event.type === "runtime_error" && isString(event.code) && isString(event.message)) {
    return event as unknown as RuntimeErrorEvent;
  }
  return null;
}

function isAudioSource(value: unknown): value is AudioSource {
  return value === "system" || value === "microphone";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
```

- [ ] **Step 4: Update session revive for optional fields**

In `lib/session-storage.ts`, revive optional `latency` date fields only when present. Use a helper:

```ts
function reviveLatency<T extends Record<string, Date | string | undefined> | undefined>(latency: T): T {
  if (!latency) return latency;
  return Object.fromEntries(
    Object.entries(latency).map(([key, value]) => [key, value ? new Date(value) : value]),
  ) as T;
}
```

Then map transcript chunks as:

```ts
transcriptChunks: session.transcriptChunks.map((chunk) => ({
  ...chunk,
  timestamp: new Date(chunk.timestamp),
  latency: reviveLatency(chunk.latency),
})),
```

- [ ] **Step 5: Verify types**

Run:

```bash
cd /home/work/asr/CueMind
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add types/session.ts types/suggestions.ts lib/desktop-events.ts lib/session-storage.ts
git commit -m "feat: add desktop transcript and context card contracts"
```

## Task 4: Add Windows Audio Helper Skeleton

**Files:**
- Create: `native/CueMind.Audio/CueMind.Audio.csproj`
- Create: `native/CueMind.Audio/Program.cs`
- Create: `native/CueMind.Audio/AudioCaptureService.cs`
- Create: `native/CueMind.Audio/JsonlEventWriter.cs`
- Create: `native/CueMind.Audio/README.md`

- [ ] **Step 1: Create .NET project file**

Create `native/CueMind.Audio/CueMind.Audio.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="NAudio" Version="2.2.1" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Implement JSONL writer**

Create `native/CueMind.Audio/JsonlEventWriter.cs`:

```csharp
using System.Text.Json;

namespace CueMind.Audio;

public sealed class JsonlEventWriter
{
    private readonly TextWriter output;
    private readonly JsonSerializerOptions options = new(JsonSerializerDefaults.Web);

    public JsonlEventWriter(TextWriter output)
    {
        this.output = output;
    }

    public void Write(object value)
    {
        output.WriteLine(JsonSerializer.Serialize(value, options));
        output.Flush();
    }
}
```

- [ ] **Step 3: Implement initial helper CLI**

Create `native/CueMind.Audio/Program.cs`:

```csharp
using CueMind.Audio;

var outputDir = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "cuemind-audio");
Directory.CreateDirectory(outputDir);

var writer = new JsonlEventWriter(Console.Out);
using var service = new AudioCaptureService(outputDir, writer);

writer.Write(new
{
    type = "runtime_status",
    status = "starting",
    occurredAt = DateTimeOffset.UtcNow,
    outputDir
});

await service.StartAsync();

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    service.Stop();
};

await service.Completion;
```

- [ ] **Step 4: Implement capture service placeholder that emits status on non-Windows**

Create `native/CueMind.Audio/AudioCaptureService.cs` with the first working boundary:

```csharp
namespace CueMind.Audio;

public sealed class AudioCaptureService : IDisposable
{
    private readonly string outputDir;
    private readonly JsonlEventWriter writer;
    private readonly TaskCompletionSource completion = new();

    public AudioCaptureService(string outputDir, JsonlEventWriter writer)
    {
        this.outputDir = outputDir;
        this.writer = writer;
    }

    public Task Completion => completion.Task;

    public Task StartAsync()
    {
        if (!OperatingSystem.IsWindows())
        {
            writer.Write(new
            {
                type = "runtime_error",
                code = "windows_required",
                message = "CueMind audio helper requires Windows WASAPI.",
                occurredAt = DateTimeOffset.UtcNow
            });
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        writer.Write(new
        {
            type = "runtime_status",
            status = "capture_ready",
            occurredAt = DateTimeOffset.UtcNow,
            outputDir
        });
        return Task.CompletedTask;
    }

    public void Stop()
    {
        completion.TrySetResult();
    }

    public void Dispose()
    {
        Stop();
    }
}
```

- [ ] **Step 5: Add helper README**

Create `native/CueMind.Audio/README.md`:

```markdown
# CueMind.Audio

Windows-only audio helper for CueMind Desktop.

## Responsibilities

- Capture default playback device with WASAPI Loopback.
- Capture default microphone.
- Emit JSONL status and chunk events to stdout.
- Write chunk audio files to a local temp directory.

## Development Commands

```bash
dotnet restore native/CueMind.Audio/CueMind.Audio.csproj
dotnet build native/CueMind.Audio/CueMind.Audio.csproj
dotnet run --project native/CueMind.Audio/CueMind.Audio.csproj -- ./tmp/audio
```

On non-Windows hosts the helper should emit `windows_required` and exit cleanly.
```

- [ ] **Step 6: Verify helper builds on Windows or fails cleanly on WSL**

Run on Windows PowerShell:

```powershell
dotnet build native/CueMind.Audio/CueMind.Audio.csproj
```

Expected: PASS on Windows with .NET 8 SDK installed.

Run in WSL if needed:

```bash
cd /home/work/asr/CueMind
dotnet build native/CueMind.Audio/CueMind.Audio.csproj
```

Expected: either PASS if Windows targeting packs are available or a documented SDK targeting-pack failure.

- [ ] **Step 7: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add native/CueMind.Audio
git commit -m "feat: add windows audio helper skeleton"
```

## Task 5: Implement Dual-Track WASAPI Capture

**Files:**
- Modify: `native/CueMind.Audio/AudioCaptureService.cs`
- Modify: `native/CueMind.Audio/CueMind.Audio.csproj`

- [ ] **Step 1: Add WAV chunk writer dependencies**

Use NAudio classes:

```csharp
using NAudio.CoreAudioApi;
using NAudio.Wave;
```

- [ ] **Step 2: Implement microphone and loopback capturers**

In `AudioCaptureService`, create one `WasapiLoopbackCapture` for default render device and one `WasapiCapture` for default capture device. Each track writes independent 5-second WAV chunks.

Required event shape:

```json
{"type":"audio_chunk_ready","id":"...","source":"system","path":"...","startedAt":"...","endedAt":"...","startMs":0,"endMs":5000,"sampleRate":48000,"channels":2}
```

- [ ] **Step 3: Keep chunks source-separated**

Write files under:

```text
<outputDir>/system/<chunk-id>.wav
<outputDir>/microphone/<chunk-id>.wav
```

Do not mix the two sources in MVP.

- [ ] **Step 4: Add silence skipping only after basic capture works**

Add an RMS threshold for both tracks. Emit a `runtime_status` event when a chunk is skipped:

```json
{"type":"runtime_status","status":"silence_skipped","source":"system","occurredAt":"..."}
```

- [ ] **Step 5: Manual verification on Windows**

Run:

```powershell
dotnet run --project native/CueMind.Audio/CueMind.Audio.csproj -- $env:TEMP\cuemind-audio
```

Expected:

- Speaking into microphone creates files under `microphone`.
- Playing meeting audio creates files under `system`.
- JSONL stdout emits separate `audio_chunk_ready` events.
- Stopping with Ctrl+C exits cleanly.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add native/CueMind.Audio
git commit -m "feat: capture windows system and microphone audio"
```

## Task 6: Add Electron Desktop Shell

**Files:**
- Modify: `package.json`
- Create: `desktop/electron/main.ts`
- Create: `desktop/electron/preload.ts`
- Create: `desktop/electron/types.ts`
- Modify: `next.config.ts`

- [ ] **Step 1: Install dependencies**

Run:

```bash
cd /home/work/asr/CueMind
npm install --save-dev electron electron-builder concurrently wait-on tsx
```

- [ ] **Step 2: Add scripts**

Modify `package.json` scripts:

```json
{
  "desktop:dev": "concurrently \"npm run dev\" \"wait-on http://localhost:3000 && tsx desktop/electron/main.ts\"",
  "desktop:build": "npm run build && electron-builder --win nsis",
  "helper:build": "dotnet publish native/CueMind.Audio/CueMind.Audio.csproj -c Release -r win-x64 --self-contained false"
}
```

- [ ] **Step 3: Create typed IPC contracts**

Create `desktop/electron/types.ts`:

```ts
export interface DesktopRuntimeStatus {
  helperRunning: boolean;
  audioOutputDir: string | null;
  lastError: string | null;
}

export interface DesktopBridge {
  getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
  startAudioHelper: () => Promise<DesktopRuntimeStatus>;
  stopAudioHelper: () => Promise<DesktopRuntimeStatus>;
}
```

- [ ] **Step 4: Create preload bridge**

Create `desktop/electron/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./types";

const bridge: DesktopBridge = {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:get-status"),
  startAudioHelper: () => ipcRenderer.invoke("runtime:start-audio-helper"),
  stopAudioHelper: () => ipcRenderer.invoke("runtime:stop-audio-helper"),
};

contextBridge.exposeInMainWorld("cuemindDesktop", bridge);
```

- [ ] **Step 5: Create Electron main process**

Create `desktop/electron/main.ts` with app startup, window creation, and helper process management using `child_process.spawn`.

Minimum behavior:

- Load `http://localhost:3000` in dev.
- In packaged mode, load the exported app URL or local server strategy chosen during packaging.
- Start helper on request.
- Kill helper on quit.
- Read helper stdout line by line and log JSONL lines for now.

- [ ] **Step 6: Type global bridge**

Create `desktop/electron/global.d.ts` if TypeScript needs it:

```ts
import type { DesktopBridge } from "./types";

declare global {
  interface Window {
    cuemindDesktop?: DesktopBridge;
  }
}
```

- [ ] **Step 7: Verify desktop dev shell**

Run:

```bash
cd /home/work/asr/CueMind
npm run desktop:dev
```

Expected: Electron window opens CueMind UI. On WSL, document if GUI is unavailable and verify at least TypeScript/build gates.

- [ ] **Step 8: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add package.json package-lock.json desktop next.config.ts
git commit -m "feat: add electron desktop shell"
```

## Task 7: Add Local whisper.cpp ASR Adapter

**Files:**
- Create: `lib/local-asr.ts`
- Create: `app/api/local-transcribe/route.ts`
- Modify: `hooks/useDesktopTranscript.ts`
- Modify: `types/settings.ts`
- Modify: `components/SettingsModal.tsx`

- [ ] **Step 1: Add settings fields**

Extend `types/settings.ts` with:

```ts
localWhisperPath: string;
localWhisperModelPath: string;
localWhisperLanguage: "auto" | "zh" | "en";
```

Update defaults in `hooks/useSettings.ts`:

```ts
localWhisperPath: "",
localWhisperModelPath: "",
localWhisperLanguage: "auto",
```

- [ ] **Step 2: Create ASR adapter**

Create `lib/local-asr.ts`:

```ts
import { spawn } from "node:child_process";

export interface LocalAsrRequest {
  whisperPath: string;
  modelPath: string;
  audioPath: string;
  language: "auto" | "zh" | "en";
}

export interface LocalAsrResult {
  text: string;
  latencyMs: number;
}

export async function transcribeWithWhisperCpp(request: LocalAsrRequest): Promise<LocalAsrResult> {
  const started = performance.now();
  const args = ["-m", request.modelPath, "-f", request.audioPath, "-otxt", "-nt"];
  if (request.language !== "auto") args.push("-l", request.language);

  const output = await runProcess(request.whisperPath, args, 60_000);
  return { text: output.trim(), latencyMs: Math.round(performance.now() - started) };
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Local ASR timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Local ASR exited with ${code}`));
    });
  });
}
```

- [ ] **Step 3: Create local transcribe route**

Create `app/api/local-transcribe/route.ts` that accepts JSON:

```json
{"audioPath":"...","source":"system","startMs":0,"endMs":5000,"settings":{"whisperPath":"...","modelPath":"...","language":"zh"}}
```

Return:

```json
{"text":"...","latencyMs":1234}
```

Validate that `audioPath`, `whisperPath`, and `modelPath` are non-empty strings. Do not accept browser-uploaded audio in this route.

- [ ] **Step 4: Add settings UI**

In `components/SettingsModal.tsx`, add fields for:

- `whisper.cpp executable path`
- `whisper model path`
- language selector: auto, Chinese, English

Label them in Chinese.

- [ ] **Step 5: Verify with a known WAV file**

Run the route through the app or curl from the desktop host. Expected: text returns and latency is recorded.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add lib/local-asr.ts app/api/local-transcribe types/settings.ts hooks/useSettings.ts components/SettingsModal.tsx
git commit -m "feat: add local whisper transcription adapter"
```

## Task 8: Add Desktop Transcript Hook

**Files:**
- Create: `hooks/useDesktopTranscript.ts`
- Modify: `app/page.tsx`
- Modify: `components/MicTranscript.tsx`

- [ ] **Step 1: Create hook that consumes desktop events**

Create `hooks/useDesktopTranscript.ts` with this public shape:

```ts
export interface UseDesktopTranscriptResult {
  isDesktop: boolean;
  isRecording: boolean;
  error: string | null;
  transcriptChunks: TranscriptChunk[];
  setTranscriptChunks: (chunks: TranscriptChunk[]) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}
```

For MVP, if `window.cuemindDesktop` is absent, return `isDesktop: false` and do not replace the browser recorder.

- [ ] **Step 2: Wire helper chunk events to local ASR**

When an `audio_chunk_ready` event arrives:

- call `/api/local-transcribe`
- include `source`, `startMs`, `endMs`, and local settings
- append a `TranscriptChunk` with `source`
- sort chunks by timestamp/startMs

- [ ] **Step 3: Preserve browser fallback**

Modify `app/page.tsx`:

```ts
const browserRecorder = useMicRecorder();
const desktopRecorder = useDesktopTranscript();
const recorder = desktopRecorder.isDesktop ? desktopRecorder : browserRecorder;
```

Keep existing component contracts working.

- [ ] **Step 4: Update transcript UI source labels**

In `components/MicTranscript.tsx`, render source tags:

- `系统音频` for `system`
- `麦克风` for `microphone`
- no tag for legacy chunks without source

- [ ] **Step 5: Verify fallback and desktop mode**

Run:

```bash
cd /home/work/asr/CueMind
npx tsc --noEmit
npm run lint
```

Expected: browser mode still compiles; desktop mode compiles even when bridge is absent.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add hooks/useDesktopTranscript.ts app/page.tsx components/MicTranscript.tsx
git commit -m "feat: consume desktop dual-track transcripts"
```

## Task 9: Add Ollama And Search-Grounded Context Cards

**Files:**
- Create: `lib/ollama.ts`
- Create: `lib/search.ts`
- Create: `app/api/context-cards/route.ts`
- Create: `hooks/useContextCards.ts`
- Modify: `components/LiveSuggestions.tsx`
- Modify: `components/SuggestionCard.tsx`
- Modify: `types/settings.ts`
- Modify: `hooks/useSettings.ts`
- Modify: `components/SettingsModal.tsx`

- [ ] **Step 1: Add settings fields**

Add:

```ts
ollamaBaseUrl: string;
ollamaModel: string;
searchProvider: "tavily" | "bing" | "serpapi";
searchApiKey: string;
contextCardCooldownSeconds: number;
```

Defaults:

```ts
ollamaBaseUrl: "http://127.0.0.1:11434",
ollamaModel: "qwen2.5:3b",
searchProvider: "tavily",
searchApiKey: "",
contextCardCooldownSeconds: 20,
```

- [ ] **Step 2: Implement Ollama JSON adapter**

Create `lib/ollama.ts` with a function:

```ts
export async function generateOllamaJson<T>(args: {
  baseUrl: string;
  model: string;
  system: string;
  prompt: string;
  timeoutMs: number;
}): Promise<T>
```

Use `POST /api/generate` with `stream: false` and `format: "json"`. Parse and return JSON. Timeout after `timeoutMs`.

- [ ] **Step 3: Implement generic search adapter**

Create `lib/search.ts` with:

```ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(args: {
  provider: "tavily" | "bing" | "serpapi";
  apiKey: string;
  query: string;
  timeoutMs: number;
}): Promise<SearchResult[]>
```

MVP rule: return at least two results or throw `InsufficientSearchSourcesError`.

- [ ] **Step 4: Create context-card route**

Create `app/api/context-cards/route.ts`.

Input:

```json
{"recentTranscript":"...","knownKeywords":["..."],"settings":{"ollamaBaseUrl":"...","ollamaModel":"...","searchProvider":"tavily","searchApiKey":"..."}}
```

Route flow:

1. Use Ollama to extract one candidate keyword as JSON.
2. Reject if keyword is empty, generic, or already known.
3. Search web with timeout.
4. If fewer than two sources, retry search once.
5. If still fewer than two sources, return `{ "card": null, "failure": { ... } }`.
6. Use Ollama to generate Chinese card JSON from transcript and sources.
7. Validate card has keyword, explanation, whyNow, exactly two sources.

- [ ] **Step 5: Add automatic card hook**

Create `hooks/useContextCards.ts`:

- Watch transcript chunks while recording.
- Use only new transcript text since last run.
- Enforce 20-second cooldown.
- Keep known keyword set.
- Store card failures separately from rendered cards.
- Do not block transcript rendering while cards are generated.

- [ ] **Step 6: Display cards**

Modify `components/LiveSuggestions.tsx` so the middle column can show sourced context cards above or instead of legacy Groq suggestions in desktop mode.

Card layout:

- Keyword title
- One-sentence explanation
- `为什么现在相关`
- Two source links
- Latency badge

- [ ] **Step 7: Verify failure behavior**

Manually test with an invalid search key.

Expected:

- Search retries once.
- No official card is rendered.
- A failure row or debug status records reason.
- App remains usable.

- [ ] **Step 8: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add lib/ollama.ts lib/search.ts app/api/context-cards hooks/useContextCards.ts components/LiveSuggestions.tsx components/SuggestionCard.tsx types/settings.ts hooks/useSettings.ts components/SettingsModal.tsx
git commit -m "feat: add sourced local context cards"
```

## Task 10: Add Latency Telemetry

**Files:**
- Create: `lib/telemetry.ts`
- Create: `components/LatencyPanel.tsx`
- Modify: `app/page.tsx`
- Modify: `hooks/useDesktopTranscript.ts`
- Modify: `hooks/useContextCards.ts`

- [ ] **Step 1: Create telemetry helpers**

Create `lib/telemetry.ts`:

```ts
export type LatencyStage = "capture" | "asr" | "keyword" | "search" | "generation" | "render" | "total";

export interface LatencySample {
  id: string;
  stage: LatencyStage;
  durationMs: number;
  createdAt: Date;
}

export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}
```

- [ ] **Step 2: Record ASR samples**

In `hooks/useDesktopTranscript.ts`, record:

- capture duration from event start/end
- ASR duration from `/api/local-transcribe`

- [ ] **Step 3: Record context-card samples**

In `hooks/useContextCards.ts`, record:

- keyword extraction duration
- search duration
- card generation duration
- total duration from latest transcript timestamp to rendered card

- [ ] **Step 4: Add latency panel**

Create `components/LatencyPanel.tsx` showing:

- ASR P50/P95
- keyword P50/P95
- search P50/P95
- generation P50/P95
- total card P50/P95
- number of skipped failures

- [ ] **Step 5: Wire panel into page**

Add the panel in `app/page.tsx` as a compact status strip or a collapsible section under the header.

- [ ] **Step 6: Verify latency budget display**

Run a short replay or manual mock event. Expected: panel shows samples and flags total P95 over 15s.

- [ ] **Step 7: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add lib/telemetry.ts components/LatencyPanel.tsx app/page.tsx hooks/useDesktopTranscript.ts hooks/useContextCards.ts
git commit -m "feat: add realtime latency telemetry"
```

## Task 11: Add Replay Mode

**Files:**
- Create: `lib/replay.ts`
- Create: `app/replay/page.tsx`
- Create: `fixtures/demo-meeting/sample-events.jsonl`
- Create: `fixtures/demo-meeting/README.md`

- [ ] **Step 1: Create replay fixture**

Create `fixtures/demo-meeting/sample-events.jsonl` with at least these event types:

```jsonl
{"type":"transcript_ready","id":"t1","audioChunkId":"a1","source":"system","text":"我们今天讨论 whisper.cpp 在 Windows 桌面端的本地转写延迟。","timestamp":"2026-08-21T10:00:00.000Z","startMs":0,"endMs":5000,"latencyMs":1200}
{"type":"transcript_ready","id":"t2","audioChunkId":"a2","source":"microphone","text":"关键词卡片需要在十五秒内给出来源。","timestamp":"2026-08-21T10:00:06.000Z","startMs":6000,"endMs":10000,"latencyMs":900}
```

- [ ] **Step 2: Implement replay parser**

Create `lib/replay.ts`:

```ts
import { parseDesktopEvent, type DesktopEvent } from "@/lib/desktop-events";

export function parseReplayEvents(raw: string): DesktopEvent[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseDesktopEvent)
    .filter((event): event is DesktopEvent => event !== null);
}
```

- [ ] **Step 3: Create replay page**

Create `app/replay/page.tsx` with:

- file input for JSONL
- play/pause/reset controls
- speed selector `1x`, `2x`, `5x`
- transcript display
- context-card hook integration if feasible; otherwise replay transcript only and mark card replay as next task

- [ ] **Step 4: Add fixture README**

Create `fixtures/demo-meeting/README.md`:

```markdown
# Demo Meeting Fixture

The final demo should use a 10-minute technical meeting recording with 8-12 AI or engineering terms. The MVP acceptance run must produce 3-5 sourced context cards and a latency breakdown with P50/P95 values.

Store raw private recordings outside git. Commit only small synthetic JSONL fixtures.
```

- [ ] **Step 5: Verify replay parser**

Run:

```bash
cd /home/work/asr/CueMind
npx tsc --noEmit
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add lib/replay.ts app/replay fixtures/demo-meeting
git commit -m "feat: add replay mode foundation"
```

## Task 12: Chinese Desktop UX Pass

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/MicTranscript.tsx`
- Modify: `components/LiveSuggestions.tsx`
- Modify: `components/ChatPanel.tsx`
- Modify: `components/SettingsModal.tsx`
- Modify: `components/SuggestionCard.tsx`
- Modify: `README.md`

- [ ] **Step 1: Translate primary UI labels**

Translate visible core labels:

- `CueMind Live Suggestions` -> `CueMind 实时会议提示`
- `Sessions` -> `会话`
- `New` -> `新建`
- `Markdown` -> `Markdown`
- `Resume` -> `恢复`
- `Not now` -> `暂不恢复`

- [ ] **Step 2: Translate desktop runtime labels**

Use Chinese labels for:

- system audio
- microphone
- local ASR
- local model
- web-search enhancement
- replay mode
- latency budget

- [ ] **Step 3: Preserve dense control-room layout**

Do not redesign the app into a landing page. Keep the three-column operational layout.

- [ ] **Step 4: Verify no text overflow**

Run the app at desktop and narrow widths. Confirm Chinese labels do not overlap the header buttons or cards.

- [ ] **Step 5: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add app components README.md
git commit -m "feat: localize desktop mvp ui"
```

## Task 13: Packaging And Runtime Checks

**Files:**
- Modify: `package.json`
- Create or modify: `electron-builder` config in `package.json` or `electron-builder.yml`
- Modify: `docs/desktop-mvp.md`

- [ ] **Step 1: Configure NSIS build**

Add electron-builder config:

```json
{
  "build": {
    "appId": "ai.cuemind.desktop",
    "productName": "CueMind Desktop",
    "files": [
      ".next/**",
      "desktop/**",
      "package.json"
    ],
    "extraResources": [
      {
        "from": "native/CueMind.Audio/bin/Release/net8.0-windows/win-x64/publish",
        "to": "CueMind.Audio"
      }
    ],
    "win": {
      "target": "nsis"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

- [ ] **Step 2: Build helper before desktop package**

Run on Windows:

```powershell
npm run helper:build
npm run desktop:build
```

Expected: NSIS installer is produced under `dist/`.

- [ ] **Step 3: Install and smoke test**

On Windows 10 22H2 or Windows 11 x64:

- install app
- launch app
- start helper
- play test audio
- speak into mic
- confirm transcript shows both `系统音频` and `麦克风`
- confirm at least one card can be generated with valid search settings

- [ ] **Step 4: Update evidence checklist**

Add final evidence rows to `docs/desktop-mvp.md`:

```markdown
## Evidence Log

| Date | Host | Check | Result | Artifact |
| --- | --- | --- | --- | --- |
| 2026-08-21 | Windows 11 x64 | Dual-track capture | Pending |  |
| 2026-08-21 | Windows 11 x64 | Local ASR tiny/base | Pending |  |
| 2026-08-21 | Windows 11 x64 | 10-min replay demo | Pending |  |
```

- [ ] **Step 5: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add package.json package-lock.json docs/desktop-mvp.md
git commit -m "build: add windows desktop packaging config"
```

## Task 14: Final Verification And Resume Material

**Files:**
- Modify: `docs/desktop-mvp.md`
- Modify: `README.md`

- [ ] **Step 1: Run full local gates**

Run:

```bash
cd /home/work/asr/CueMind
npx tsc --noEmit
npm run lint
npm run build
```

Expected: PASS before calling implementation complete.

- [ ] **Step 2: Run Windows demo evidence**

Run the 10-minute demo recording.

Expected:

- 3-5 cards generated.
- Each card has exactly two source links.
- Total card latency P50 <= 8s.
- Total card latency P95 <= 15s.
- Failures are counted and explained.

- [ ] **Step 3: Add resume bullet draft**

Add to `docs/desktop-mvp.md`:

```markdown
## Resume Bullet

Built a Windows desktop realtime meeting cognition assistant by extending a Next.js meeting copilot with Electron, C#/.NET WASAPI dual-track audio capture, local whisper.cpp transcription, local Ollama keyword/card generation, web-search grounding, replay mode, and stage-level latency telemetry; demoed a 10-minute technical meeting with 3-5 sourced Chinese context cards under a P50 <= 8s / P95 <= 15s card-latency budget.
```

- [ ] **Step 4: Add interview explanation outline**

Add:

```markdown
## Interview Explanation

1. Problem: people miss technical context during live meetings, and post-meeting summaries arrive too late.
2. Constraint: meeting audio should not be uploaded; browser capture cannot reliably get remote meeting audio.
3. Architecture: desktop helper captures system and microphone audio separately, local ASR transcribes both, local LLM extracts keywords, search grounds explanations, UI renders short cards.
4. Engineering tradeoff: dual-track capture costs more ASR work but improves attribution, debugging, and telemetry.
5. Reliability: search retries once, source-insufficient cards are skipped, replay mode reproduces failures.
6. Metrics: stage-level latency makes the project measurable rather than a vague AI demo.
```

- [ ] **Step 5: Commit**

Run:

```bash
cd /home/work/asr/CueMind
git add docs/desktop-mvp.md README.md
git commit -m "docs: add desktop mvp evidence and interview notes"
```

## Definition Of Done

- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- `npm run build` passes.
- Windows helper captures default system audio and default microphone as separate sources.
- Local `whisper.cpp` produces transcript chunks for both sources.
- Context cards are generated by local Ollama and grounded by two web sources.
- Retrieval failure retries once and then skips without showing an unsourced official card.
- Latency panel reports ASR, keyword, search, generation, render, and total latency.
- Replay mode can reproduce at least one fixture and one 10-minute demo run.
- `docs/desktop-mvp.md` states privacy boundaries accurately: local audio/transcript/model inference, web-search-enhanced context.
- README no longer implies the desktop MVP is fully offline.

## Risk Register

- **Windows helper complexity:** WASAPI works only on Windows; WSL cannot fully verify capture. Mitigation: keep helper isolated and provide non-Windows clean failure.
- **Local ASR quality:** `tiny/base` may miss technical terms. Mitigation: measure errors and document model-size tradeoff; add `small` as second-stage option.
- **Ollama latency:** local 7B may exceed P95 budget on weak CPUs. Mitigation: default to 3B, cap card length, enforce cooldown.
- **Search privacy:** keywords leave the machine. Mitigation: clear UI label and docs; avoid sending full transcript.
- **Packaging size:** bundling helper and model can be heavy. Mitigation: first release requires user-configured model path; second stage can add managed model download.
- **Card hallucination:** local LLM may overstate source content. Mitigation: card prompt must cite only returned snippets; skip if validation fails.

## Second-Stage Backlog

- Add `small` and quantized ASR model comparisons with WER and latency table.
- Add local RAG cache for company/internal terms.
- Add offline-only mode that disables search and labels cards as unverified local explanations.
- Add optional faster-whisper GPU adapter.
- Add speaker diarization research spike.
- Add automatic model download and integrity checks.
- Add update channel and signed installer.
