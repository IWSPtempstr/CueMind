export type LatencyStage = "capture" | "asr" | "keyword" | "search" | "generation" | "render" | "total";

export interface LatencySample {
  id: string;
  stage: LatencyStage;
  durationMs: number;
  createdAt: Date;
}

export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function summarizeLatency(samples: LatencySample[], stage: LatencyStage): { count: number; p50: number | null; p95: number | null } {
  const durations = samples.filter((sample) => sample.stage === stage).map((sample) => sample.durationMs);
  return { count: durations.length, p50: percentile(durations, 50), p95: percentile(durations, 95) };
}
