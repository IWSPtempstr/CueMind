import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";

interface SmokeReport {
  modelPath: string;
  audioPath: string;
  language: "zh";
  provider: "local-whisper";
  textLength: number;
  segmentCount: number;
  audioDurationMs: number | null;
  latencyMs: number;
  realTimeFactor: number | null;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
}

async function main(): Promise<void> {
  const whisperArg = process.argv[2];
  const modelArg = process.argv[3];
  const audioArg = process.argv[4];
  const whisperPath = resolve(whisperArg ?? "");
  const modelPath = resolve(modelArg ?? "");
  const audioPath = resolve(audioArg ?? "");
  const reportPath = process.argv[5] ? resolve(process.argv[5]) : null;
  if (!whisperArg || !modelArg || !audioArg) {
    throw new Error("Usage: run-local-asr-smoke.ts <whisper-cli> <model> <wav> [report.json]");
  }

  const result = await transcribeWithWhisperCpp({
    whisperPath,
    modelPath,
    audioPath,
    language: "zh",
    timeoutMs: 180_000,
  });
  const report: SmokeReport = {
    modelPath,
    audioPath,
    language: "zh",
    provider: result.provider,
    textLength: result.text.length,
    segmentCount: result.segments.length,
    audioDurationMs: result.audioDurationMs,
    latencyMs: result.latencyMs,
    realTimeFactor: result.realTimeFactor,
    segments: result.segments,
  };
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

void main();
