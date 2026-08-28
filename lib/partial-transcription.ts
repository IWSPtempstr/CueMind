// Pure helpers backing the mic-link partial transcription channel (decision 66).
// partial 态仅用于 UI 展示：confirmed 文本（整段转写返回）才是卡片链路的
// 唯一消费源——partial 永不写入 transcriptChunks、不触发 context-cards。

/** partial 重转写最小间隔；CPU 保护（whisper RTF 实测 0.43，避免重转写风暴）。 */
export const PARTIAL_INTERVAL_MS = 4000;

/** 低于该字节数的进行中 blob 不值得发起 partial 转写。 */
export const PARTIAL_MIN_BYTES = 1000;

export interface PartialDecisionInput {
  /** 上一轮 partial 请求是否仍在途（单飞约束：禁止并发 partial）。 */
  inFlight: boolean;
  /** 目标 segment 的 MediaRecorder 状态；非 recording 一律跳过。 */
  segmentState: "recording" | "inactive" | "paused";
  /** segment 已积累 parts 的字节大小。 */
  blobSize: number;
  /** segment 峰值电平（沿用麦克风静音阈值语义）。 */
  peakLevel: number;
  /** 当前时间戳（ms）。 */
  nowMs: number;
  /** 上一次 partial 尝试时间戳（ms）；null 表示从未尝试。 */
  lastAttemptMs: number | null;
  /** 节流间隔，默认 PARTIAL_INTERVAL_MS。 */
  intervalMs?: number;
  /** 最小字节数，默认 PARTIAL_MIN_BYTES。 */
  minBytes?: number;
  /** 静音阈值（与 useMicRecorder 的 SILENCE_RMS_THRESHOLD 一致）。 */
  silenceThreshold?: number;
}

/** 决定本轮是否应发起 partial 转写（纯函数，供 hook 与单测共用）。 */
export function shouldRunPartialTranscription(input: PartialDecisionInput): boolean {
  if (input.inFlight) return false;
  if (input.segmentState !== "recording") return false;
  if (input.blobSize < (input.minBytes ?? PARTIAL_MIN_BYTES)) return false;
  if (input.peakLevel < (input.silenceThreshold ?? 0.012)) return false;
  const intervalMs = input.intervalMs ?? PARTIAL_INTERVAL_MS;
  if (input.lastAttemptMs !== null && input.nowMs - input.lastAttemptMs < intervalMs) return false;
  return true;
}
