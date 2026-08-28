import assert from "node:assert/strict";
import { PARTIAL_INTERVAL_MS, PARTIAL_MIN_BYTES, shouldRunPartialTranscription } from "@/lib/partial-transcription";

function base(overrides: Partial<Parameters<typeof shouldRunPartialTranscription>[0]> = {}): Parameters<typeof shouldRunPartialTranscription>[0] {
  return {
    inFlight: false,
    segmentState: "recording",
    blobSize: 5000,
    peakLevel: 0.5,
    nowMs: 100_000,
    lastAttemptMs: null,
    ...overrides,
  };
}

function main(): void {
  // 基线：健康的进行中 segment 允许发起 partial。
  assert.equal(shouldRunPartialTranscription(base()), true);

  // 单飞：上一轮仍在途时跳过。
  assert.equal(shouldRunPartialTranscription(base({ inFlight: true })), false);

  // 非 recording 状态（已停/已暂停）一律跳过。
  assert.equal(shouldRunPartialTranscription(base({ segmentState: "inactive" })), false);
  assert.equal(shouldRunPartialTranscription(base({ segmentState: "paused" })), false);

  // blob 太小不值得转写。
  assert.equal(shouldRunPartialTranscription(base({ blobSize: PARTIAL_MIN_BYTES - 1 })), false);
  assert.equal(shouldRunPartialTranscription(base({ blobSize: PARTIAL_MIN_BYTES })), true);

  // 静音 segment 跳过（CPU 保护）。
  assert.equal(shouldRunPartialTranscription(base({ peakLevel: 0.001 })), false);

  // 节流：距上次尝试不足间隔时跳过；恰好到达间隔则放行。
  assert.equal(shouldRunPartialTranscription(base({ lastAttemptMs: 100_000 - (PARTIAL_INTERVAL_MS - 1) })), false);
  assert.equal(shouldRunPartialTranscription(base({ lastAttemptMs: 100_000 - PARTIAL_INTERVAL_MS })), true);

  // 自定义 interval 生效。
  assert.equal(
    shouldRunPartialTranscription(base({ lastAttemptMs: 90_000, intervalMs: 5000 })),
    true,
  );
  assert.equal(
    shouldRunPartialTranscription(base({ lastAttemptMs: 97_000, intervalMs: 5000 })),
    false,
  );

  // 多条件叠加：静音 + 距离不足 → 任一为否即否。
  assert.equal(
    shouldRunPartialTranscription(base({ peakLevel: 0.001, lastAttemptMs: 99_999 })),
    false,
  );

  // confirmed 替换语义的纯函数面：partial 只在主 segment 存活时被展示，
  // 该守卫逻辑在 hook（primarySegmentRef 比对），此处锁定节流常量不被意外改动。
  assert.equal(PARTIAL_INTERVAL_MS >= 4000, true, "partial 间隔必须 >=4s（CPU 红线）");

  console.log("partial transcription assertions passed");
}

main();
