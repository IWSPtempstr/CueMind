import { chmod, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { transcribeWithWhisperCpp } from "@/lib/local-asr";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cuemind-asr-test-"));
  try {
  const executable = join(root, "fake-whisper.sh");
  const wav = join(root, "sample.wav");
  const script = `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-of" ]; then output="$2"; shift 2; continue; fi
  shift
done
cat > "$output.json" <<'JSON'
{"transcription":[{"offsets":{"from":0,"to":1200},"text":" KV Cache "},{"offsets":{"from":1200,"to":2400},"text":" 提升吞吐 "}]}
JSON
printf 'ignored progress output\\n'
`;
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  await writeFile(wav, createWavHeader(16_000, 1, 16, 16_000), undefined);

  const result = await transcribeWithWhisperCpp({
    whisperPath: executable,
    modelPath: join(root, "qwen-whisper-small.bin"),
    audioPath: wav,
    language: "zh",
  });

  assert.equal(result.text, "KV Cache 提升吞吐");
  assert.deepEqual(result.segments, [
    { startMs: 0, endMs: 1200, text: "KV Cache" },
    { startMs: 1200, endMs: 2400, text: "提升吞吐" },
  ]);
  assert.equal(result.audioDurationMs, 500);
  assert.equal(result.provider, "local-whisper");
  assert.equal(result.modelPath.endsWith("qwen-whisper-small.bin"), true);
  assert.equal(typeof result.latencyMs, "number");

  const output = await readFile(executable, "utf8");
  assert.match(output, /ignored progress output/);
    console.log("local ASR adapter assertions passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createWavHeader(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

void main();
