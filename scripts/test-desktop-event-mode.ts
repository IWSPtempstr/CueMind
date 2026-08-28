import assert from "node:assert/strict";
import {
  AUDIO_SOURCE_MODE_LABELS,
  normalizeAudioSourceMode,
  serializeAudioSourceArgs,
} from "@/lib/audio-source-mode";
import { parseDesktopEvent } from "@/lib/desktop-events";

// P3 桌面输入源模式回归（node:assert 风格，纯函数、无 IO）：
// a) serializeAudioSourceArgs：三种合法模式 + 非法值回落 mixed
// b) normalizeAudioSourceMode：边界与大小写
// c) AUDIO_SOURCE_MODE_LABELS：与模式一一对应（切换按钮 / HealthPanel 共用）
// d) parseDesktopEvent 现有回归：audio_chunk_ready / runtime_error / runtime_status
// e) runtime_status capture_ready 新增 sources 字段的解析

// a) serializeAudioSourceArgs → C# helper argv 片段
assert.deepEqual(serializeAudioSourceArgs("mic"), ["--sources", "mic"]);
assert.deepEqual(serializeAudioSourceArgs("system"), ["--sources", "system"]);
assert.deepEqual(serializeAudioSourceArgs("mixed"), ["--sources", "mixed"]);
// 非法值一律回落 mixed
assert.deepEqual(serializeAudioSourceArgs("bogus"), ["--sources", "mixed"]);
assert.deepEqual(serializeAudioSourceArgs(""), ["--sources", "mixed"]);
assert.deepEqual(serializeAudioSourceArgs("MIC"), ["--sources", "mixed"]); // 大小写敏感
assert.deepEqual(serializeAudioSourceArgs(undefined), ["--sources", "mixed"]);
assert.deepEqual(serializeAudioSourceArgs(null), ["--sources", "mixed"]);
assert.deepEqual(serializeAudioSourceArgs(42), ["--sources", "mixed"]);
assert.deepEqual(serializeAudioSourceArgs(["mic"]), ["--sources", "mixed"]);

// b) normalizeAudioSourceMode
assert.equal(normalizeAudioSourceMode("mic"), "mic");
assert.equal(normalizeAudioSourceMode("system"), "system");
assert.equal(normalizeAudioSourceMode("mixed"), "mixed");
assert.equal(normalizeAudioSourceMode("both"), "mixed");
assert.equal(normalizeAudioSourceMode(undefined), "mixed");
assert.equal(normalizeAudioSourceMode({ mode: "mic" }), "mixed");

// c) 标签完备性
assert.deepEqual(Object.keys(AUDIO_SOURCE_MODE_LABELS).sort(), ["mic", "mixed", "system"]);
for (const [mode, label] of Object.entries(AUDIO_SOURCE_MODE_LABELS)) {
  assert.ok(label.length > 0, `mode ${mode} 应有非空标签`);
}

// d) parseDesktopEvent 现有回归
const chunk = parseDesktopEvent(JSON.stringify({
  type: "audio_chunk_ready",
  id: "chunk-1",
  source: "microphone",
  path: String.raw`C:\audio\microphone\a.wav`,
  startedAt: "2026-08-27T10:00:00.000Z",
  endedAt: "2026-08-27T10:00:05.000Z",
  startMs: 0,
  endMs: 5000,
  sampleRate: 48000,
  channels: 2,
}));
if (!chunk || chunk.type !== "audio_chunk_ready") throw new Error("audio_chunk_ready 应正常解析");
assert.equal(chunk.id, "chunk-1");
assert.equal(chunk.source, "microphone");
assert.equal(chunk.endMs, 5000);
assert.equal(chunk.sampleRate, 48000);
// 新 helper 带 energy（窗口峰值 RMS）→ 解析透出；本条无 energy 字段 → undefined。
assert.equal(chunk.energy, undefined);

const chunkWithEnergy = parseDesktopEvent(JSON.stringify({
  type: "audio_chunk_ready",
  id: "chunk-e",
  source: "system",
  path: String.raw`C:\audio\system\b.wav`,
  startedAt: "2026-08-27T10:00:05.000Z",
  endedAt: "2026-08-27T10:00:10.000Z",
  startMs: 5000,
  endMs: 10000,
  sampleRate: 48000,
  channels: 2,
  energy: 0.4213,
}));
if (!chunkWithEnergy || chunkWithEnergy.type !== "audio_chunk_ready") throw new Error("带 energy 的 audio_chunk_ready 应正常解析");
assert.equal(chunkWithEnergy.energy, 0.4213);
// 非法 energy（字符串/NaN）宽容丢弃，事件仍解析。
const chunkBadEnergy = parseDesktopEvent(JSON.stringify({
  type: "audio_chunk_ready",
  id: "chunk-b",
  source: "system",
  path: "x",
  startedAt: "2026-08-27T10:00:10.000Z",
  endedAt: "2026-08-27T10:00:15.000Z",
  startMs: 10000,
  endMs: 15000,
  sampleRate: 48000,
  channels: 2,
  energy: "loud",
}));
if (chunkBadEnergy && chunkBadEnergy.type === "audio_chunk_ready") {
  assert.equal(chunkBadEnergy.energy, undefined);
}

const error = parseDesktopEvent(JSON.stringify({
  type: "runtime_error",
  code: "windows_required",
  message: "CueMind audio helper requires Windows WASAPI.",
  occurredAt: "2026-08-27T10:00:00.000Z",
}));
if (!error || error.type !== "runtime_error") throw new Error("runtime_error 应正常解析");
assert.equal(error.code, "windows_required");

const trackStarted = parseDesktopEvent(JSON.stringify({
  type: "runtime_status",
  status: "track_started",
  occurredAt: "2026-08-27T10:00:00.000Z",
  source: "system",
  sampleRate: 44100,
  channels: 2,
}));
if (!trackStarted || trackStarted.type !== "runtime_status") throw new Error("runtime_status 应正常解析");
assert.equal(trackStarted.source, "system");

// 非法输入仍返回 null
assert.equal(parseDesktopEvent("not-json"), null);
assert.equal(parseDesktopEvent(JSON.stringify({ type: "mystery" })), null);
assert.equal(parseDesktopEvent(JSON.stringify({ type: "audio_chunk_ready" })), null); // 缺字段

// e) capture_ready 携带 sources 字段（P3-1 新增）
const captureReady = parseDesktopEvent(JSON.stringify({
  type: "runtime_status",
  status: "capture_ready",
  occurredAt: "2026-08-27T10:00:00.000Z",
  outputDir: String.raw`C:\audio`,
  sources: "mic",
}));
if (!captureReady || captureReady.type !== "runtime_status") throw new Error("capture_ready 应正常解析");
assert.equal(captureReady.status, "capture_ready");
assert.equal(captureReady.sources, "mic");
assert.equal(captureReady.source, undefined); // 与单轨 source 字段互不影响

// 无 sources 字段时不出现在解析结果中
const readyNoSources = parseDesktopEvent(JSON.stringify({
  type: "runtime_status",
  status: "capture_ready",
  occurredAt: "2026-08-27T10:00:00.000Z",
}));
if (!readyNoSources || readyNoSources.type !== "runtime_status") throw new Error("capture_ready 应正常解析");
assert.equal(readyNoSources.sources, undefined);

console.log("test-desktop-event-mode: all assertions passed");
