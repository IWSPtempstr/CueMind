import { percentile } from "@/lib/telemetry";

export interface AsrMeasurement {
  id: string;
  audioDurationMs: number | null;
  elapsedMs: number;
  firstPartialMs: number | null;
  confirmedMs: number | null;
  status: "ok" | "failed" | "not_applicable";
}

export interface AsrSummary {
  count: number;
  successfulCount: number;
  failedCount: number;
  notApplicableCount: number;
  audioDurationMs: number;
  elapsedMs: number;
  audioSecondsPerSecond: number | null;
  realTimeFactor: number | null;
  firstPartialP50Ms: number | null;
  firstPartialP95Ms: number | null;
  confirmedP50Ms: number | null;
  confirmedP95Ms: number | null;
}

export function summarizeAsrMeasurements(runs: AsrMeasurement[]): AsrSummary {
  const measured = runs.filter((run) => run.status !== "not_applicable");
  const successful = runs.filter((run) => run.status === "ok");
  const audioDurationMs = successful.reduce((sum, run) => sum + Math.max(0, run.audioDurationMs ?? 0), 0);
  const elapsedMs = measured.reduce((sum, run) => sum + Math.max(0, run.elapsedMs), 0);
  const partials = successful.map((run) => run.firstPartialMs).filter((value): value is number => value !== null && value >= 0);
  const confirmed = successful.map((run) => run.confirmedMs).filter((value): value is number => value !== null && value >= 0);
  return {
    count: runs.length,
    successfulCount: successful.length,
    failedCount: runs.filter((run) => run.status === "failed").length,
    notApplicableCount: runs.filter((run) => run.status === "not_applicable").length,
    audioDurationMs,
    elapsedMs,
    audioSecondsPerSecond: elapsedMs > 0 && audioDurationMs > 0 ? audioDurationMs / elapsedMs : null,
    realTimeFactor: audioDurationMs > 0 ? elapsedMs / audioDurationMs : null,
    firstPartialP50Ms: percentile(partials, 50),
    firstPartialP95Ms: percentile(partials, 95),
    confirmedP50Ms: percentile(confirmed, 50),
    confirmedP95Ms: percentile(confirmed, 95),
  };
}

export interface SegmentLike { startMs: number; endMs: number; text: string }

export function validateSegmentTimeline(segments: SegmentLike[]): { ordered: boolean; overlaps: number; duplicates: number; empty: number } {
  let overlaps = 0;
  let duplicates = 0;
  let empty = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    if (current.endMs < current.startMs) throw new Error(`segment interval invalid at index ${index}`);
    if (current.text.trim().length === 0) empty += 1;
    if (index > 0) {
      const previous = segments[index - 1];
      if (current.startMs < previous.startMs) throw new Error(`segment order regressed at index ${index}`);
      if (current.startMs < previous.endMs) overlaps += 1;
      if (current.startMs === previous.startMs && current.endMs === previous.endMs && current.text.trim() === previous.text.trim()) duplicates += 1;
    }
  }
  return { ordered: true, overlaps, duplicates, empty };
}
