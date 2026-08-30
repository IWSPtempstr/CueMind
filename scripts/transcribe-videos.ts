import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";

const root = path.resolve(process.env.CUEMIND_ROOT ?? process.cwd());
const inputDir = path.resolve(process.env.VIDEO_INPUT_DIR ?? path.join(root, "dataset"));
const outputDir = path.resolve(process.env.VIDEO_TRANSCRIPT_OUTPUT_DIR ?? path.join(root, "reports/video-reimport-20260830-cuda-zh/transcripts"));
const whisperPath = path.resolve(process.env.WHISPER_PATH ?? "/home/work/asr/whisper.cpp/build-cuda/bin/whisper-cli");
const modelPath = path.resolve(process.env.WHISPER_MODEL ?? "/home/work/asr/.runtime/models/ggml-small.bin");

function run(command: string, args: string[]): Promise<void> { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`))); }); }
async function main(): Promise<void> {
  if (!existsSync(whisperPath) || !existsSync(modelPath)) throw new Error(`missing whisper/model: ${whisperPath} / ${modelPath}`);
  const files = readdirSync(inputDir).filter((file) => file.toLowerCase().endsWith(".mp4")).sort(); await import("node:fs/promises").then(({ mkdir }) => mkdir(outputDir, { recursive: true }));
  const pending = files.filter((file) => !existsSync(path.join(outputDir, `${file.replace(/\.mp4$/i, "")}.json`)));
  console.log(JSON.stringify({ inputDir, outputDir, total: files.length, pending: pending.length, skipped: files.length - pending.length }));
  for (const file of pending) {
    const media = path.join(inputDir, file); const stem = file.replace(/\.mp4$/i, ""); const temp = await mkdtemp(path.join(tmpdir(), "cuemind-video-asr-")); const wav = path.join(temp, "audio.wav");
    const started = Date.now();
    try {
      await run("ffmpeg", ["-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      const result = await transcribeWithWhisperCpp({ whisperPath, modelPath, audioPath: wav, language: "zh", timeoutMs: 1_800_000 });
      await writeFile(path.join(outputDir, `${stem}.json`), `${JSON.stringify({ video: file, modelPath, whisperPath, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started, transcription: result.segments.map((segment) => ({ offsets: { from: segment.startMs, to: segment.endMs }, text: segment.text })) }, null, 2)}\n`, "utf8");
      await writeFile(path.join(outputDir, `${stem}.txt`), `${result.text}\n`, "utf8");
      console.log(JSON.stringify({ video: file, elapsedMs: Date.now() - started, audioDurationMs: result.audioDurationMs, segmentCount: result.segments.length }));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
