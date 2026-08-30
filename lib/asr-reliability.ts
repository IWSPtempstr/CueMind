export interface ConfirmedSnapshot { atMs: number; text: string }
export interface AsrRun { audioMs: number; elapsedMs: number }
export interface AsrMetrics { runCount: number; audioMs: number; elapsedMs: number; throughputAudioSecondsPerSecond: number; realTimeFactor: number | null }

/** confirmed 只能追加前缀；相同快照视为重复提交并拒绝。 */
export function assertConfirmedProgress(snapshots: ConfirmedSnapshot[]): void {
  for (let i = 1; i < snapshots.length; i += 1) {
    const previous = snapshots[i - 1].text;
    const current = snapshots[i].text;
    if (current === previous || !current.startsWith(previous)) throw new Error(`confirmed text regressed or repeated at index ${i}`);
    if (snapshots[i].atMs < snapshots[i - 1].atMs) throw new Error(`confirmed timestamp regressed at index ${i}`);
  }
}

export function summarizeAsrRuns(runs: AsrRun[]): AsrMetrics {
  const audioMs = runs.reduce((sum, run) => sum + Math.max(0, run.audioMs), 0);
  const elapsedMs = runs.reduce((sum, run) => sum + Math.max(0, run.elapsedMs), 0);
  return { runCount: runs.length, audioMs, elapsedMs, throughputAudioSecondsPerSecond: elapsedMs > 0 ? audioMs / elapsedMs : 0, realTimeFactor: audioMs > 0 ? elapsedMs / audioMs : null };
}
