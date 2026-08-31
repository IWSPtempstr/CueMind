import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";
import { summarizeAsrMeasurements, validateSegmentTimeline, type AsrMeasurement } from "@/lib/performance-metrics";

const execFileAsync = promisify(execFile);
const root = path.resolve(process.env.CUEMIND_ROOT ?? process.cwd());
const inputDir = path.resolve(process.env.ASR_INPUT_DIR ?? path.join(root, "dataset"));
const outputDir = path.resolve(process.env.ASR_EVAL_OUTPUT ?? path.join(root, "reports", "performance-resilience", `asr-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const whisperPath = path.resolve(process.env.WHISPER_PATH ?? "/home/work/asr/whisper.cpp/build-cuda/bin/whisper-cli");
const modelPath = path.resolve(process.env.WHISPER_MODEL ?? "/home/work/asr/.runtime/models/ggml-small.bin");
const language = (process.env.ASR_LANGUAGE === "en" ? "en" : process.env.ASR_LANGUAGE === "auto" ? "auto" : "zh") as "auto" | "zh" | "en";
const maxVideos = Number.isFinite(Number(process.env.ASR_EVAL_MAX_VIDEOS)) ? Math.max(1, Number(process.env.ASR_EVAL_MAX_VIDEOS)) : 15;

interface InputEntry { id: string; path: string; kind: "audio" | "video"; language?: "auto" | "zh" | "en"; cacheMode?: "cold" | "warm" }

function parseManifest(raw: unknown): InputEntry[] {
  const entries: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).entries) ? (raw as Record<string, unknown>).entries as unknown[] : [];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`invalid ASR manifest entry ${index}`);
    const value = entry as Record<string, unknown>;
    const file = typeof value.path === "string" ? value.path : typeof value.file === "string" ? value.file : "";
    if (!file) throw new Error(`ASR manifest entry ${index} has no path`);
    const resolved = path.resolve(file);
    const kind = path.extname(resolved).toLowerCase() === ".mp4" ? "video" : "audio";
    return { id: typeof value.id === "string" && value.id.trim() ? value.id : path.basename(resolved), path: resolved, kind, language: value.language === "en" || value.language === "auto" ? value.language : value.language === "zh" ? "zh" : undefined, cacheMode: value.cacheMode === "cold" ? "cold" : "warm" };
  });
}

async function loadInputs(): Promise<InputEntry[]> {
  const manifestPath = process.env.ASR_EVAL_MANIFEST?.trim();
  if (manifestPath) return parseManifest(JSON.parse(await readFile(path.resolve(manifestPath), "utf8")));
  if (!existsSync(inputDir)) throw new Error(`ASR input directory does not exist: ${inputDir}`);
  return readdirSync(inputDir).filter((file) => /\.(mp4|wav|mp3|m4a)$/i.test(file)).sort().slice(0, maxVideos).map((file) => ({ id: file, path: path.join(inputDir, file), kind: path.extname(file).toLowerCase() === ".mp4" ? "video" : "audio", cacheMode: "warm" }));
}

async function extractWav(entry: InputEntry): Promise<{ wavPath: string; tempDir: string | null }> {
  if (entry.kind === "audio" && path.extname(entry.path).toLowerCase() === ".wav") return { wavPath: entry.path, tempDir: null };
  const tempDir = await mkdtemp(path.join(tmpdir(), "cuemind-asr-eval-"));
  const wavPath = path.join(tempDir, "audio.wav");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", entry.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath]);
  return { wavPath, tempDir };
}

async function main(): Promise<void> {
  if (!existsSync(whisperPath) || !existsSync(modelPath)) throw new Error(`missing whisper/model: ${whisperPath} / ${modelPath}`);
  const inputs = await loadInputs();
  if (inputs.length === 0) throw new Error("no ASR inputs found");
  const runs: Array<Record<string, unknown>> = [];
  const measurements: AsrMeasurement[] = [];
  for (const entry of inputs) {
    const started = performance.now();
    let tempDir: string | null = null;
    const rssBefore = process.memoryUsage().rss;
    try {
      if (!existsSync(entry.path)) throw new Error(`input does not exist: ${entry.path}`);
      const extracted = await extractWav(entry);
      tempDir = extracted.tempDir;
      const result = await transcribeWithWhisperCpp({ whisperPath, modelPath, audioPath: extracted.wavPath, language: entry.language ?? language, timeoutMs: 1_800_000 });
      const elapsedMs = Math.round(performance.now() - started);
      const segmentIntegrity = validateSegmentTimeline(result.segments);
      const measurement: AsrMeasurement = { id: entry.id, audioDurationMs: result.audioDurationMs, elapsedMs, firstPartialMs: null, confirmedMs: null, status: "ok" };
      measurements.push(measurement);
      runs.push({ id: entry.id, inputKind: entry.kind, status: "ok", cacheMode: entry.cacheMode ?? "warm", audioDurationMs: result.audioDurationMs, elapsedMs, realTimeFactor: result.realTimeFactor, audioSecondsPerSecond: result.audioDurationMs && elapsedMs > 0 ? result.audioDurationMs / elapsedMs : null, segmentCount: result.segments.length, segmentIntegrity, firstPartialMs: null, confirmedMs: null, partialConfirmedEvidence: "unavailable_in_cli_per_request_mode", rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss });
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - started);
      measurements.push({ id: entry.id, audioDurationMs: null, elapsedMs, firstPartialMs: null, confirmedMs: null, status: "failed" });
      runs.push({ id: entry.id, inputKind: entry.kind, status: "failed", elapsedMs, error: error instanceof Error ? error.message : String(error), rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss });
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }
  const summary = summarizeAsrMeasurements(measurements);
  const manifest = { evaluator: "asr-latency-evaluator-v1", generatedAt: new Date().toISOString(), inputDir, inputCount: inputs.length, whisperPath, modelPath, language, executionMode: "real_local_whisper_cpp", partialConfirmedMode: "unavailable_in_cli_per_request_mode", evidenceBoundary: "Real local whisper.cpp process timing and segment integrity. CLI per-request execution does not prove resident streaming partial/confirmed latency." };
  const failures = runs.filter((run) => run.status === "failed");
  const scorecard = { evaluator: manifest.evaluator, status: failures.length === 0 ? "complete" : "partial", denominator: { total: runs.length, succeeded: runs.filter((run) => run.status === "ok").length, failed: failures.length, notApplicable: 0 }, summary, failures: failures.map((run) => ({ id: run.id, error: run.error })), evidenceBoundary: manifest.evidenceBoundary };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "cases.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n"),
    writeFile(path.join(outputDir, "failures.jsonl"), failures.map((run) => JSON.stringify(run)).join("\n") + (failures.length ? "\n" : "")),
    writeFile(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(path.join(outputDir, "report.md"), `# ASR latency and throughput report\n\n- Status: ${scorecard.status}\n- Inputs: ${runs.length}\n- Success/failed: ${scorecard.denominator.succeeded}/${scorecard.denominator.failed}\n- Audio throughput (audio seconds/second): ${summary.audioSecondsPerSecond ?? "null"}\n- RTF: ${summary.realTimeFactor ?? "null"}\n- First partial/confirmed: unavailable in CLI per-request mode\n- Evidence: ${manifest.evidenceBoundary}\n`),
  ]);
  console.log(`ASR evaluation report written to ${outputDir}`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
