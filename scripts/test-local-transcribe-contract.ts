import assert from "node:assert/strict";
import { parseLocalTranscribeRequest } from "@/lib/local-transcribe-contract";

const valid = parseLocalTranscribeRequest({
  runId: "segment-1",
  audioPath: "/tmp/window.wav",
  source: "microphone",
  startMs: 0,
  endMs: 5000,
  settings: {
    whisperPath: "/opt/whisper-cli",
    modelPath: "/opt/ggml.bin",
    language: "auto",
  },
});
assert.equal(valid?.runId, "segment-1");

assert.equal(parseLocalTranscribeRequest({
  audioPath: "/tmp/window.wav",
  source: "microphone",
  startMs: 0,
  endMs: 5000,
  settings: { whisperPath: "/opt/whisper-cli", modelPath: "/opt/ggml.bin", language: "auto" },
}), null);

assert.equal(parseLocalTranscribeRequest({
  runId: "x".repeat(161),
  audioPath: "/tmp/window.wav",
  source: "microphone",
  startMs: 0,
  endMs: 5000,
  settings: { whisperPath: "/opt/whisper-cli", modelPath: "/opt/ggml.bin", language: "auto" },
}), null);

console.log("local transcribe contract tests passed");
