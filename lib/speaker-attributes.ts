// 双通道说话人归属（主线二 2.2-a）：零模型、纯 DSP 接口，无副作用。
// 2.2-b 增量：attributeChunkSpeaker（hook 接线裁决，仅 mixed 双轨标注）与
// speakerBadge（MicTranscript 行内徽标），均为纯函数、末段定义。
// ① 裁决（2026-08-28）：接口就位 + 映射退化。AudioChunkReadyEvent 当前无 energy 字段，
//    运行时能量恒为 undefined/null → 泄漏判定跳过，实际退化为通道确定性映射
//    （microphone→you / system→remote）。
// ② C# capture_ready 未来透出 energy 字段后，本函数自动升级为能量泄漏跟随判定，
//    调用侧无需改动（energy 为可选字段，事件与 overlapWith 透传即可生效）。
// ③ pyannote 云端 diarization 明确不做（决策 58 / local-first 红线）；
//    角色标签即终态（对齐 meetscribe 先例）。

import type { AudioSourceMode } from "@/lib/audio-source-mode";
import type { AudioSource } from "@/types/session";

export type Speaker = "you" | "remote";

/** 桌面双轨采集源（types/session.ts AudioSource 的桌面取值；upload 不参与双轨归属）。 */
export type AttributionSource = "microphone" | "system";

/** 泄漏判定比例：本轨能量 < 主轨能量 × 0.3（30%）视为串音泄漏，跟随主轨标签。 */
export const LEAK_ENERGY_RATIO = 0.3;

export interface TrackAttributionInput {
  /** 采集轨道：microphone（本机）→ you；system（远端播放）→ remote。 */
  source: AttributionSource;
  /** 0..1 RMS 能量；当前 C# 事件无此字段 → undefined，泄漏判定跳过。 */
  energy?: number | null;
  /** 时间重叠的对轨 chunk；startMs/endMs 供函数复核区间是否真实相交。 */
  overlapWith?: {
    source: AttributionSource;
    energy?: number | null;
    startMs: number;
    endMs: number;
  } | null;
  /** 本轨 chunk 时间区间；缺省时信任 overlapWith 的时间重叠声明。 */
  startMs?: number;
  endMs?: number;
}

function baseSpeaker(source: AttributionSource): Speaker {
  return source === "microphone" ? "you" : "remote";
}

/** 能量有效性：有限非负数字；undefined/null/NaN/负数/Infinity 均无效。 */
function isValidEnergy(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasTimeOverlap(
  input: TrackAttributionInput,
  overlap: NonNullable<TrackAttributionInput["overlapWith"]>,
): boolean {
  // 本轨区间未知（startMs/endMs 缺省）→ 信任调用方的时间重叠声明；
  // 区间已知则复核（半开区间相交，贴边不算重叠）。
  if (typeof input.startMs !== "number" || typeof input.endMs !== "number") return true;
  return input.startMs < overlap.endMs && overlap.startMs < input.endMs;
}

/**
 * 单 chunk 说话人裁决（纯函数）：
 * - 基础映射：microphone → "you"；system → "remote"。
 * - 存在时间重叠的对轨 chunk 且双方能量均为有效数字时：能量高者为主轨，
 *   本轨能量 < 主轨 × LEAK_ENERGY_RATIO 判为串音泄漏、跟随主轨标签；
 *   能量相当（或本轨更高）→ 各归各通道（同时说话）。
 * - 任一能量无效（undefined/null/NaN/负数）→ 纯通道映射（当前运行时路径）。
 */
export function attributeSpeaker(input: TrackAttributionInput): Speaker {
  const own = baseSpeaker(input.source);
  const overlap = input.overlapWith;
  if (!overlap || !hasTimeOverlap(input, overlap)) return own;
  if (!isValidEnergy(input.energy) || !isValidEnergy(overlap.energy)) return own;
  if (input.energy >= overlap.energy) return own;
  return input.energy < overlap.energy * LEAK_ENERGY_RATIO ? baseSpeaker(overlap.source) : own;
}

// ---- 遗留窗口 API（useDesktopTranscript 运行时路径仍在用；语义并入 attributeSpeaker 核心）----

export type SpeakerRole = Speaker;

/** 遗留别名，等价 LEAK_ENERGY_RATIO。 */
export const SPEAKER_LEAKAGE_RATIO = LEAK_ENERGY_RATIO;

export const SPEAKER_ROLE_LABELS: Record<SpeakerRole, string> = {
  you: "我",
  remote: "对方",
};

export interface SpeakerWindow {
  source: AttributionSource;
  startMs: number;
  endMs: number;
  /** 窗口峰值电平 0..1；缺失按 1 处理（等价能量未知 → 纯通道映射语义）。 */
  peakLevel?: number;
}

function windowsOverlap(a: SpeakerWindow, b: SpeakerWindow): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * 遗留单窗口裁决：otherTrack 传对轨（mic↔system）窗口序列，内部按 source 与
 * 时间重叠过滤、取能量最强者为主轨，再交由 attributeSpeaker 核心裁决。
 */
export function resolveSpeakerRole(window: SpeakerWindow, otherTrack: SpeakerWindow[]): SpeakerRole {
  let strongest: SpeakerWindow | null = null;
  for (const other of otherTrack) {
    if (other.source === window.source) continue;
    if (!windowsOverlap(window, other)) continue;
    if (strongest === null || (other.peakLevel ?? 1) > (strongest.peakLevel ?? 1)) strongest = other;
  }
  if (strongest === null) return baseSpeaker(window.source);
  return attributeSpeaker({
    source: window.source,
    energy: window.peakLevel ?? 1,
    overlapWith: {
      source: strongest.source,
      energy: strongest.peakLevel ?? 1,
      startMs: strongest.startMs,
      endMs: strongest.endMs,
    },
    startMs: window.startMs,
    endMs: window.endMs,
  });
}

/** 遗留批量版：对序列内每个窗口按其余窗口做对轨裁决，返回带 speaker 的副本。 */
export function attributeSpeakers(
  windows: SpeakerWindow[],
): Array<SpeakerWindow & { speaker: SpeakerRole }> {
  return windows.map((window) => ({
    ...window,
    speaker: resolveSpeakerRole(window, windows),
  }));
}

// ---- 2.2-b 接线层（useDesktopTranscript → chunk.speaker）与 UI 徽标（MicTranscript）----

/**
 * hook 接线裁决（纯函数，供单测）：仅 mixed 双轨模式标注说话人；
 * 单轨（mic|system 模式）与上传轨（upload）不标（行为零变化红线）。
 * mixed 下委托 resolveSpeakerRole：AudioChunkReadyEvent 无能量字段 → 纯通道映射退化路径。
 */
export function attributeChunkSpeaker(
  mode: AudioSourceMode,
  source: AudioSource,
  startMs: number,
  endMs: number,
  otherTrack: SpeakerWindow[],
): SpeakerRole | undefined {
  if (mode !== "mixed") return undefined;
  if (source !== "microphone" && source !== "system") return undefined;
  return resolveSpeakerRole({ source, startMs, endMs }, otherTrack);
}

/**
 * 转写行内说话人徽标（纯函数，供单测）：角色 → YOU/REMOTE 文案与角色色类名；
 * 基础形 rounded border px-1.5 py-0.5 text-[10px] 在组件侧拼接。
 */
export function speakerBadge(speaker: SpeakerRole): { label: string; className: string } {
  return speaker === "you"
    ? { label: "YOU", className: "border-blue-800 text-blue-300" }
    : { label: "REMOTE", className: "border-emerald-800 text-emerald-300" };
}
