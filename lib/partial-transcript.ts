// Partial 转写节流纯函数（决策 66，主线二 2.1-a）。
// 范围裁决（master plan 2.1）：partial 仅麦克风链路；桌面链路 5s chunk 已近实时、
// 上传链路有 SSE 进度，均不做。
// 红线：partial 只作 UI 展示态（partialText），绝不写 transcriptChunks、绝不触发
// context-cards——卡片链路只消费 confirmed 文本。
// 全部为输入→输出的纯函数（无副作用、不改入参），供 hook 与单测直接调用。

/** partial 重转写最小间隔；CPU 保护（whisper RTF 实测 0.43，避免重转写风暴）。 */
export const PARTIAL_INTERVAL_MS = 4000;

/** 低于该字节数的进行中音频不发起 partial（约 0.3s opus 音频，过滤过碎片段）。 */
export const MIN_PARTIAL_BYTES = 4000;

/** partial 节流状态：上次发送时间戳（ms；0 表示从未发送）+ 是否有在途请求。 */
export interface PartialThrottleState {
  lastSentAt: number;
  inFlight: boolean;
}

export interface PartialSendGuards {
  /** segment 是否处于可转写状态（recording 且未暂停/未停止）。 */
  isRecording: boolean;
  /** 是否有在途 partial 请求（单飞约束：禁止并发 partial）。 */
  hasInFlight: boolean;
  /** segment 已积累的音频字节数。 */
  accumulatedBytes: number;
}

/**
 * 节流判定：segment 进行中 + 距上次发送 ≥ PARTIAL_INTERVAL_MS
 * + 无在途请求 + parts 有足够字节。
 */
export function shouldSendPartial(state: PartialThrottleState, now: number, opts: PartialSendGuards): boolean {
  if (!opts.isRecording) return false;
  if (state.inFlight || opts.hasInFlight) return false;
  if (opts.accumulatedBytes < MIN_PARTIAL_BYTES) return false;
  if (now - state.lastSentAt < PARTIAL_INTERVAL_MS) return false;
  return true;
}

/** partial 发送后的状态推进：lastSentAt 更新为 now（不动 inFlight，由调用方管理）。 */
export function onPartialSent(state: PartialThrottleState, now: number): PartialThrottleState {
  return { ...state, lastSentAt: now };
}

/** partial→confirmed 替换语义：confirmed 到达时清 partial 周期与在途标记，开启新周期。 */
export function onConfirmed(state: PartialThrottleState): PartialThrottleState {
  return { lastSentAt: 0, inFlight: false };
}
