import assert from "node:assert/strict";
import {
  FIRST_PARTIAL_THRESHOLD_MS,
  MIN_PARTIAL_BYTES,
  PARTIAL_INTERVAL_MS,
  freshThrottleState,
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

  // i) 两段式首 partial：新 segment 创建后 1s（<2s 门限）不放行，2s 起放行；
  //    发送过一次后回到 4s 间隔（不因 fresh 状态重复吃 2s 快速通道）。
  const segStart = BASE;
  let fresh = freshThrottleState(segStart);
  assert.equal(fresh.lastSentAt, 0);
  assert.equal(fresh.segmentStartedAt, segStart);
  assert.equal(shouldSendPartial(fresh, segStart + 1000, opts()), false); // 1s：首门限未到
  assert.equal(shouldSendPartial(fresh, segStart + FIRST_PARTIAL_THRESHOLD_MS, opts()), true); // 2s：首 partial 放行
  fresh = onPartialSent(fresh, segStart + FIRST_PARTIAL_THRESHOLD_MS);
  assert.equal(shouldSendPartial(fresh, segStart + FIRST_PARTIAL_THRESHOLD_MS + 1000, opts()), false); // 3s：回到 4s 节流
  assert.equal(shouldSendPartial(fresh, segStart + FIRST_PARTIAL_THRESHOLD_MS + PARTIAL_INTERVAL_MS, opts()), true); // 6s：间隔满放行

  // j) 老 segment 字节数不足时即便过了 2s 首门限也不放行（守卫叠加）。
  const smallFresh = freshThrottleState(BASE);
  assert.equal(shouldSendPartial(smallFresh, BASE + FIRST_PARTIAL_THRESHOLD_MS, opts({ accumulatedBytes: MIN_PARTIAL_BYTES - 1 })), false);

  // k) 无 segmentStartedAt 的旧式状态（lastSentAt=0）保持 4s 起步（向后兼容）。
  assert.equal(shouldSendPartial(state(), FIRST_PARTIAL_THRESHOLD_MS, opts()), false);
  assert.equal(shouldSendPartial(state(), PARTIAL_INTERVAL_MS, opts()), true);

  // l) onConfirmed 清 segmentStartedAt：新周期不再以 segment 创建时刻为门限。
  //    fresh 态距创建 1s 不放行；confirmed 后（lastSentAt=0、无基准）同一时刻放行——
  //    证明 2s 快速通道已被清除，回到"无基准即按已流逝时长判定"的老语义。
  const lateBase = 1_000_000; // 与 BASE 无关的远端时钟（保证已流逝时长 > 4s）
  const lateFresh = freshThrottleState(lateBase);
  assert.equal(shouldSendPartial(lateFresh, lateBase + 1000, opts()), false); // 距创建 1s：不放行
  const afterConfirm = onConfirmed(onPartialSent(lateFresh, lateBase + 2000));
  assert.equal("segmentStartedAt" in afterConfirm, false);
  assert.equal(shouldSendPartial(afterConfirm, lateBase + 2100, opts()), true);

  console.log("partial transcript assertions passed");
}

main();
