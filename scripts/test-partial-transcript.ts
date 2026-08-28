import assert from "node:assert/strict";
import {
  MIN_PARTIAL_BYTES,
  PARTIAL_INTERVAL_MS,
  onConfirmed,
  onPartialSent,
  shouldSendPartial,
  type PartialSendGuards,
  type PartialThrottleState,
} from "@/lib/partial-transcript";

// 模拟时间基点（ms）；真实调用里 lastSentAt 初值为 0、now 为 Date.now()。
const BASE = 100_000;

function state(overrides: Partial<PartialThrottleState> = {}): PartialThrottleState {
  return { lastSentAt: 0, inFlight: false, ...overrides };
}

function opts(overrides: Partial<PartialSendGuards> = {}): PartialSendGuards {
  return { isRecording: true, hasInFlight: false, accumulatedBytes: 8000, ...overrides };
}

function main(): void {
  // a) recording + ≥4s + 无在途 + 字节够 → true。
  assert.equal(shouldSendPartial(state(), BASE, opts()), true);

  // b) 距上次 <4s → false（节流）；恰好到达间隔放行。
  assert.equal(shouldSendPartial(state({ lastSentAt: BASE - (PARTIAL_INTERVAL_MS - 1) }), BASE, opts()), false);
  assert.equal(shouldSendPartial(state({ lastSentAt: BASE - PARTIAL_INTERVAL_MS }), BASE, opts()), true);

  // c) 在途请求禁止并发：opts.hasInFlight 与 state.inFlight 任一为真都跳过。
  assert.equal(shouldSendPartial(state(), BASE, opts({ hasInFlight: true })), false);
  assert.equal(shouldSendPartial(state({ inFlight: true }), BASE, opts()), false);

  // d) 字节不足（过碎片段）不发送；恰达阈值放行。
  assert.equal(shouldSendPartial(state(), BASE, opts({ accumulatedBytes: MIN_PARTIAL_BYTES - 1 })), false);
  assert.equal(shouldSendPartial(state(), BASE, opts({ accumulatedBytes: MIN_PARTIAL_BYTES })), true);

  // e) 非 recording（已暂停/已停止）一律跳过。
  assert.equal(shouldSendPartial(state(), BASE, opts({ isRecording: false })), false);

  // f) onPartialSent 更新 lastSentAt：立即再判 false，4s 后 true；不改入参（纯函数）。
  const beforeF = state();
  const sent = onPartialSent(beforeF, BASE);
  assert.equal(sent.lastSentAt, BASE);
  assert.equal(sent.inFlight, false);
  assert.deepEqual(beforeF, { lastSentAt: 0, inFlight: false });
  assert.equal(shouldSendPartial(sent, BASE, opts()), false);
  assert.equal(shouldSendPartial(sent, BASE + PARTIAL_INTERVAL_MS, opts()), true);

  // g) onConfirmed 清 inFlight（并重置节流周期）→ 后续可再发送；不改入参。
  const beforeG = state({ lastSentAt: BASE, inFlight: true });
  const confirmed = onConfirmed(beforeG);
  assert.equal(confirmed.inFlight, false);
  assert.deepEqual(beforeG, { lastSentAt: BASE, inFlight: true });
  assert.equal(shouldSendPartial(confirmed, BASE + 100, opts()), true);

  // h) 时序模拟：0s 发送 → 1s tick false → 4.1s tick true → confirmed → 5s tick true（新周期）。
  let timeline = state();
  const t0 = BASE;
  assert.equal(shouldSendPartial(timeline, t0, opts()), true); // 0s 发送
  timeline = onPartialSent(timeline, t0);
  timeline = { ...timeline, inFlight: true }; // 请求在途（调用方管理 inFlight）
  const t1 = t0 + 1000;
  assert.equal(shouldSendPartial(timeline, t1, opts({ hasInFlight: timeline.inFlight })), false); // 1s tick：节流
  timeline = { ...timeline, inFlight: false }; // partial 请求完成
  const t2 = t0 + 4100;
  assert.equal(shouldSendPartial(timeline, t2, opts()), true); // 4.1s tick：放行
  timeline = onPartialSent(timeline, t2);
  timeline = { ...timeline, inFlight: true };
  timeline = onConfirmed(timeline); // confirmed 到达：清 partial 周期
  assert.equal(timeline.inFlight, false);
  const t3 = t0 + 5000;
  assert.equal(shouldSendPartial(timeline, t3, opts()), true); // 5s tick：新周期放行

  // 常量红线：节流间隔与最小字节数锁定预期值。
  assert.equal(PARTIAL_INTERVAL_MS, 4000);
  assert.equal(MIN_PARTIAL_BYTES, 4000);

  console.log("partial transcript assertions passed");
}

main();
