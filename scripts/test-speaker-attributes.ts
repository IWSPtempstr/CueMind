import assert from "node:assert/strict";
import {
  SPEAKER_LEAKAGE_RATIO,
  SPEAKER_ROLE_LABELS,
  attributeSpeakers,
  resolveSpeakerRole,
  type SpeakerWindow,
} from "@/lib/speaker-attributes";

function win(source: SpeakerWindow["source"], startMs: number, endMs: number, peakLevel?: number): SpeakerWindow {
  return { source, startMs, endMs, peakLevel };
}

function main(): void {
  // --- 单轨：无对轨窗口 → 本轨角色 ---
  assert.equal(resolveSpeakerRole(win("system", 0, 5000), []), "remote");
  assert.equal(resolveSpeakerRole(win("microphone", 0, 5000), []), "you");

  // --- 双轨无时间重叠：各归各轨 ---
  assert.equal(
    resolveSpeakerRole(win("system", 6000, 11000), [win("microphone", 0, 5000)]),
    "remote",
  );

  // --- 时间重叠 + 无电平数据（按 1 处理）：双方都"在场"，保持本轨角色 ---
  assert.equal(
    resolveSpeakerRole(win("system", 0, 5000), [win("microphone", 0, 5000)]),
    "remote",
  );
  assert.equal(
    resolveSpeakerRole(win("microphone", 0, 5000), [win("system", 0, 5000)]),
    "you",
  );

  // --- 重叠 + 本轨能量占优：保持本轨角色 ---
  assert.equal(
    resolveSpeakerRole(win("system", 0, 5000, 0.8), [win("microphone", 0, 5000, 0.4)]),
    "remote",
  );
  assert.equal(
    resolveSpeakerRole(win("microphone", 0, 5000, 0.9), [win("system", 0, 5000, 0.5)]),
    "you",
  );

  // --- 重叠 + 本轨能量为泄漏（< 主轨 × 0.3）：跟随主轨 ---
  assert.equal(
    resolveSpeakerRole(win("system", 0, 5000, 0.1), [win("microphone", 0, 5000, 0.8)]),
    "you",
  );
  assert.equal(
    resolveSpeakerRole(win("microphone", 0, 5000, 0.2), [win("system", 0, 5000, 0.9)]),
    "remote",
  );

  // --- 泄漏边界：恰好等于 0.3 倍不判泄漏（保持本轨）---
  assert.equal(
    resolveSpeakerRole(
      win("system", 0, 5000, 0.3),
      [win("microphone", 0, 5000, 1.0)],
    ),
    "remote",
  );
  assert.ok(SPEAKER_LEAKAGE_RATIO > 0 && SPEAKER_LEAKAGE_RATIO < 1);

  // --- 多个对轨重叠：取能量最强者做主轨比较 ---
  assert.equal(
    resolveSpeakerRole(
      win("system", 0, 5000, 0.1),
      [win("microphone", 0, 2000, 0.3), win("microphone", 3000, 8000, 0.9)],
    ),
    "you",
  );

  // --- 同轨窗口被忽略（只做对轨比较）---
  assert.equal(
    resolveSpeakerRole(win("system", 0, 5000, 0.1), [win("system", 0, 5000, 0.9)]),
    "remote",
  );

  // --- 批量 API：混合序列整体裁决 ---
  const attributed = attributeSpeakers([
    win("microphone", 0, 5000, 0.8),      // 对轨静默窗口 → you
    win("system", 1000, 6000, 0.05),      // 泄漏 → 跟随 mic → you
    win("system", 6500, 11000, 0.9),      // 独占时段 → remote
    win("microphone", 7000, 12000, 0.05), // 泄漏 → 跟随 system → remote
  ]);
  assert.deepEqual(attributed.map((item) => item.speaker), ["you", "you", "remote", "remote"]);
  // 原窗口字段保留。
  assert.equal(attributed[2].startMs, 6500);
  assert.equal(attributed[3].peakLevel, 0.05);

  // --- 标签字典：角色可渲染 ---
  assert.equal(SPEAKER_ROLE_LABELS.you, "我");
  assert.equal(SPEAKER_ROLE_LABELS.remote, "对方");

  console.log("speaker attribute assertions passed");
}

main();
