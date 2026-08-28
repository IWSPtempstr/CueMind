import assert from "node:assert/strict";
import {
  attributeSpeaker,
  attributeSpeakers,
  LEAK_ENERGY_RATIO,
  resolveSpeakerRole,
  SPEAKER_LEAKAGE_RATIO,
  SPEAKER_ROLE_LABELS,
  type TrackAttributionInput,
} from "@/lib/speaker-attributes";

// 主线二 2.2-a 说话人归属回归（node:assert 风格，纯函数、无 IO、零模型）：
// 裁决（2026-08-28）= 接口就位 + 映射退化：AudioChunkReadyEvent 无 energy 字段，
// 运行时能量恒 undefined/null → 泄漏判定跳过、纯通道映射（mic→you / system→remote）；
// C# capture_ready 未来透出 energy 后泄漏判定自动生效，调用侧无需改动。
// a) 单轨通道映射  b) 能量无效退化  c) 泄漏跟随  d) 能量相当各归各
// e) 泄漏边界（严格小于）  f) 区间不相交视为无重叠  g) 纯函数不改入参  h) 确定性
// 末段附遗留窗口 API 回归（useDesktopTranscript 运行时路径）。

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
// 标签字典：角色可渲染
assert.equal(SPEAKER_ROLE_LABELS.you, "我");
assert.equal(SPEAKER_ROLE_LABELS.remote, "对方");

console.log("test-speaker-attributes: all assertions passed");
