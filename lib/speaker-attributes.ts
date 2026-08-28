// 双通道说话人归属（决策 58 边界下的纯 DSP 能量标注）：
// Windows 双轨采集天然分离 mic/system 两轨——按通道归属角色（YOU/REMOTE），
// 零模型成本。时间重叠区能量高者为主；本轨能量低于主轨 30% 判为串音泄漏，
// 跟随主轨标签。不做 pyannote 云端 diarization（local-first 红线），
// 不做真实说话人姓名（角色标签即终态，对齐 meetscribe 先例）。

export type SpeakerRole = "you" | "remote";

/** 泄漏判定比例：本轨能量 < 主轨能量 × 0.3 视为串音。 */
export const SPEAKER_LEAKAGE_RATIO = 0.3;

export const SPEAKER_ROLE_LABELS: Record<SpeakerRole, string> = {
  you: "我",
  remote: "对方",
};

export interface SpeakerWindow {
  /** 采集轨道：microphone（本机）或 system（远端播放）。 */
  source: "microphone" | "system";
  startMs: number;
  endMs: number;
  /** 窗口峰值电平 0..1；缺失按 1 处理（仅剩时间重叠语义）。 */
  peakLevel?: number;
}

function baseRole(source: SpeakerWindow["source"]): SpeakerRole {
  return source === "microphone" ? "you" : "remote";
}

function level(window: SpeakerWindow): number {
  return window.peakLevel ?? 1;
}

function overlaps(a: SpeakerWindow, b: SpeakerWindow): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * 单窗口角色裁决：otherTrack 传对轨（mic↔system）窗口序列（可含本窗口之外的任意集合，
 * 函数内部按 source 与时间重叠过滤）。无重叠 → 本轨角色；有重叠 → 能量高者为主，
 * 本轨能量低于主轨 SPEAKER_LEAKAGE_RATIO 倍判为泄漏、跟随主轨。
 */
export function resolveSpeakerRole(window: SpeakerWindow, otherTrack: SpeakerWindow[]): SpeakerRole {
  let strongest: SpeakerWindow | null = null;
  for (const other of otherTrack) {
    if (other.source === window.source) continue;
    if (!overlaps(window, other)) continue;
    if (strongest === null || level(other) > level(strongest)) strongest = other;
  }
  if (strongest === null) return baseRole(window.source);
  if (level(window) < level(strongest) * SPEAKER_LEAKAGE_RATIO) {
    return baseRole(strongest.source);
  }
  return baseRole(window.source);
}

/** 批量版：对序列内每个窗口按其余窗口做对轨裁决，返回带 speaker 的副本。 */
export function attributeSpeakers(
  windows: SpeakerWindow[],
): Array<SpeakerWindow & { speaker: SpeakerRole }> {
  return windows.map((window) => ({
    ...window,
    speaker: resolveSpeakerRole(window, windows),
  }));
}
