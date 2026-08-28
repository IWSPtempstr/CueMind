import assert from "node:assert/strict";
import {
  attributeChunkSpeaker,
  attributeSpeaker,
  attributeSpeakers,
  LEAK_ENERGY_RATIO,
  resolveSpeakerRole,
  speakerBadge,
  SPEAKER_LEAKAGE_RATIO,
  type TrackAttributionInput,
} from "@/lib/speaker-attributes";

// 主线二 2.2-a 说话人归属回归（node:assert 风格，纯函数、无 IO、零模型）：
// energy 已激活（2026-08-28）：C# 透出窗口峰值 RMS → 泄漏跟随（<30%）生效；
// 旧版 helper 无 energy 字段 → 自动退化为通道确定性映射（microphone→you /
// system→remote）。
// a) 单轨通道映射  b) 能量无效退化  c) 泄漏跟随  d) 能量相当各归各
// e) 泄漏边界（严格小于）  f) 区间不相交视为无重叠  g) 纯函数不改入参  h) 确定性
// 末段附遗留窗口 API 回归（useDesktopTranscript 运行时路径）与 2.2-b 接线层/UI
// 徽标纯函数回归（attributeChunkSpeaker / speakerBadge）。

// a) 单轨：无对轨 chunk → 纯通道映射
assert.equal(attributeSpeaker({ source: "microphone" }), "you");
assert.equal(attributeSpeaker({ source: "system" }), "remote");
// 带时间区间、无 overlapWith 同样纯映射
assert.equal(attributeSpeaker({ source: "microphone", startMs: 0, endMs: 5000 }), "you");
assert.equal(attributeSpeaker({ source: "system", startMs: 5000, endMs: 10000 }), "remote");

// b) 能量无效（undefined/null/NaN/负数/Infinity）→ 即使带 overlapWith 也纯映射退化
const loudSystem = { source: "system" as const, energy: 0.9, startMs: 0, endMs: 5000 };
assert.equal(attributeSpeaker({ source: "microphone", energy: undefined, overlapWith: loudSystem }), "you");
assert.equal(attributeSpeaker({ source: "microphone", energy: null, overlapWith: loudSystem }), "you");
assert.equal(attributeSpeaker({ source: "microphone", energy: Number.NaN, overlapWith: loudSystem }), "you");
assert.equal(attributeSpeaker({ source: "microphone", energy: -0.2, overlapWith: loudSystem }), "you");
assert.equal(attributeSpeaker({ source: "microphone", energy: Number.POSITIVE_INFINITY, overlapWith: loudSystem }), "you");
// 对轨能量无效同样退化
assert.equal(
  attributeSpeaker({ source: "microphone", energy: 0.9, overlapWith: { ...loudSystem, energy: undefined } }),
  "you",
);
assert.equal(
  attributeSpeaker({ source: "system", energy: 0.9, overlapWith: { source: "microphone", energy: null, startMs: 0, endMs: 5000 } }),
  "remote",
);

// c) 双轨时间重叠：system 0.8 > mic 0.2 且 0.2 < 0.8×0.3=0.24 → mic 泄漏跟随 "remote"
const micLeak: TrackAttributionInput = {
  source: "microphone",
  energy: 0.2,
  startMs: 0,
  endMs: 5000,
  overlapWith: { source: "system", energy: 0.8, startMs: 0, endMs: 5000 },
};
const systemMain: TrackAttributionInput = {
  source: "system",
  energy: 0.8,
  startMs: 0,
  endMs: 5000,
  overlapWith: { source: "microphone", energy: 0.2, startMs: 0, endMs: 5000 },
};
assert.equal(attributeSpeaker(micLeak), "remote"); // mic 泄漏 → 跟随主轨
assert.equal(attributeSpeaker(systemMain), "remote"); // system 主轨 → 本轨

// d) 双轨重叠能量相当（0.5 / 0.45）→ 同时说话，各归各
assert.equal(
  attributeSpeaker({
    source: "microphone",
    energy: 0.5,
    startMs: 0,
    endMs: 5000,
    overlapWith: { source: "system", energy: 0.45, startMs: 0, endMs: 5000 },
  }),
  "you",
);
assert.equal(
  attributeSpeaker({
    source: "system",
    energy: 0.45,
    startMs: 0,
    endMs: 5000,
    overlapWith: { source: "microphone", energy: 0.5, startMs: 0, endMs: 5000 },
  }),
  "remote",
);

// e) 泄漏边界：mic 能量恰 = 0.8×0.3 → 严格小于不成立 → 不判泄漏 → mic 保持 "you"
// （用与阈值相同的表达式 0.8 * LEAK_ENERGY_RATIO 构造边界值，规避 0.24 字面量的浮点表示误差）
assert.equal(LEAK_ENERGY_RATIO, 0.3);
assert.equal(SPEAKER_LEAKAGE_RATIO, LEAK_ENERGY_RATIO);
assert.equal(
  attributeSpeaker({
    source: "microphone",
    energy: 0.8 * LEAK_ENERGY_RATIO,
    startMs: 0,
    endMs: 5000,
    overlapWith: { source: "system", energy: 0.8, startMs: 0, endMs: 5000 },
  }),
  "you",
);
// 略低于边界（0.23 < 0.24）才判泄漏
assert.equal(
  attributeSpeaker({
    source: "microphone",
    energy: 0.23,
    startMs: 0,
    endMs: 5000,
    overlapWith: { source: "system", energy: 0.8, startMs: 0, endMs: 5000 },
  }),
  "remote",
);

// f) 有 overlapWith 但 startMs/endMs 区间不相交 → 视为无重叠 → 纯映射
// （0.1 vs 0.9 本应判泄漏，仅因区间不相交而退化）
assert.equal(
  attributeSpeaker({
    source: "microphone",
    energy: 0.1,
    startMs: 6000,
    endMs: 11000,
    overlapWith: { source: "system", energy: 0.9, startMs: 0, endMs: 5000 },
  }),
  "you",
);
assert.equal(
  attributeSpeaker({
    source: "system",
    energy: 0.1,
    startMs: 6000,
    endMs: 11000,
    overlapWith: { source: "microphone", energy: 0.9, startMs: 0, endMs: 5000 },
  }),
  "remote",
);
// 贴边相接（半开区间 [0,5000) 与 [5000,11000)）不算重叠
assert.equal(
  attributeSpeaker({
    source: "microphone",
    energy: 0.1,
    startMs: 5000,
    endMs: 11000,
    overlapWith: { source: "system", energy: 0.9, startMs: 0, endMs: 5000 },
  }),
  "you",
);

// g) 纯函数不改入参：浅冻结后调用，入参保持原样且仍冻结
const frozenInput: TrackAttributionInput = Object.freeze({
  source: "microphone",
  energy: 0.2,
  startMs: 0,
  endMs: 5000,
  overlapWith: loudSystem,
});
const frozenSnapshot = structuredClone(frozenInput);
assert.equal(attributeSpeaker(frozenInput), "remote");
assert.ok(Object.isFrozen(frozenInput));
assert.deepEqual(frozenInput, frozenSnapshot);

// h) 确定性：同一输入多次调用结果一致
const repeatInput: TrackAttributionInput = { ...micLeak };
const firstResult = attributeSpeaker(repeatInput);
for (let i = 0; i < 5; i += 1) {
  assert.equal(attributeSpeaker(repeatInput), firstResult);
}

// ---- 遗留窗口 API 回归（hooks/useDesktopTranscript 运行时路径，语义并入新核心）----
assert.equal(resolveSpeakerRole({ source: "system", startMs: 0, endMs: 5000 }, []), "remote");
assert.equal(resolveSpeakerRole({ source: "microphone", startMs: 0, endMs: 5000 }, []), "you");
// 无电平数据（当前运行时路径）：时间重叠也各归各轨
assert.equal(
  resolveSpeakerRole({ source: "system", startMs: 0, endMs: 5000 }, [{ source: "microphone", startMs: 0, endMs: 5000 }]),
  "remote",
);
assert.equal(
  resolveSpeakerRole({ source: "microphone", startMs: 0, endMs: 5000 }, [{ source: "system", startMs: 0, endMs: 5000 }]),
  "you",
);
// 泄漏跟随 + 边界（恰等于倍数不判泄漏）
assert.equal(
  resolveSpeakerRole(
    { source: "microphone", startMs: 0, endMs: 5000, peakLevel: 0.2 },
    [{ source: "system", startMs: 0, endMs: 5000, peakLevel: 0.9 }],
  ),
  "remote",
);
assert.equal(
  resolveSpeakerRole(
    { source: "system", startMs: 0, endMs: 5000, peakLevel: 1.0 },
    [{ source: "microphone", startMs: 0, endMs: 5000, peakLevel: 0.3 }],
  ),
  "remote",
);
// 区间不相交不参与比较
assert.equal(
  resolveSpeakerRole(
    { source: "microphone", startMs: 6000, endMs: 11000, peakLevel: 0.2 },
    [{ source: "system", startMs: 0, endMs: 5000, peakLevel: 0.9 }],
  ),
  "you",
);
// 批量 API：整体裁决 + 原窗口字段保留
const attributed = attributeSpeakers([
  { source: "microphone", startMs: 0, endMs: 5000, peakLevel: 0.8 },
  { source: "system", startMs: 1000, endMs: 6000, peakLevel: 0.05 }, // 泄漏 → 跟随 mic → you
  { source: "system", startMs: 6500, endMs: 11000, peakLevel: 0.9 }, // 独占时段 → remote
]);
assert.deepEqual(attributed.map((item) => item.speaker), ["you", "you", "remote"]);
assert.equal(attributed[1].startMs, 1000);
assert.equal(attributed[2].peakLevel, 0.9);

// ---- 2.2-b 接线层回归：attributeChunkSpeaker（hook → chunk.speaker 的可测纯裁决）----
// 仅 mixed 双轨模式标注；单轨（mic|system 模式）不标（行为零变化红线）
assert.equal(attributeChunkSpeaker("mixed", "microphone", 0, 5000, []), "you");
assert.equal(attributeChunkSpeaker("mixed", "system", 0, 5000, []), "remote");
assert.equal(attributeChunkSpeaker("mic", "microphone", 0, 5000, []), undefined);
assert.equal(attributeChunkSpeaker("system", "system", 0, 5000, []), undefined);
// 单轨模式下即使 recentEventsRef 残留对轨窗口（模式切换前的旧事件）也不标
assert.equal(
  attributeChunkSpeaker("mic", "microphone", 0, 5000, [{ source: "system", startMs: 0, endMs: 5000 }]),
  undefined,
);
// 上传轨不参与归属
assert.equal(attributeChunkSpeaker("mixed", "upload", 0, 5000, []), undefined);
// mixed 下委托 resolveSpeakerRole：无能量字段 → 时间重叠也各归各轨（纯映射退化路径）
assert.equal(
  attributeChunkSpeaker("mixed", "microphone", 0, 5000, [{ source: "system", startMs: 0, endMs: 5000 }]),
  "you",
);
assert.equal(
  attributeChunkSpeaker("mixed", "system", 0, 5000, [{ source: "microphone", startMs: 0, endMs: 5000 }]),
  "remote",
);
// energy 激活（C# 透出后）：本窗 0.05 < 对轨 0.9 × 0.3 → 泄漏跟随主轨；
// 本窗能量占优时保持本轨角色（重叠区能量比较生效）。
assert.equal(
  attributeChunkSpeaker("mixed", "microphone", 0, 5000, [{ source: "system", startMs: 0, endMs: 5000, peakLevel: 0.9 }], 0.05),
  "remote",
);
assert.equal(
  attributeChunkSpeaker("mixed", "system", 0, 5000, [{ source: "microphone", startMs: 0, endMs: 5000, peakLevel: 0.1 }], 0.8),
  "remote",
);
assert.equal(
  attributeChunkSpeaker("mixed", "microphone", 0, 5000, [{ source: "system", startMs: 0, endMs: 5000, peakLevel: 0.1 }], 0.8),
  "you",
);
// 边界：本窗能量恰等于对轨 × 0.3（不算泄漏）→ 保持本轨。
assert.equal(
  attributeChunkSpeaker("mixed", "microphone", 0, 5000, [{ source: "system", startMs: 0, endMs: 5000, peakLevel: 1.0 }], 0.3),
  "you",
);

// ---- 2.2-b UI 徽标回归：speakerBadge（MicTranscript 行内 YOU/REMOTE）----
assert.deepEqual(speakerBadge("you"), { label: "YOU", className: "border-blue-800 text-blue-300" });
assert.deepEqual(speakerBadge("remote"), { label: "REMOTE", className: "border-emerald-800 text-emerald-300" });

console.log("test-speaker-attributes: all assertions passed");
