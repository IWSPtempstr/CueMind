export interface RealtimeScorecard { releaseDecision: "keep-cli" | "manual-review"; gatesPassed: boolean; executedCases: number; failures: string[]; confirmedDuplicates: number; rollbackCount: number }
export function buildRealtimeScorecard(input: Omit<RealtimeScorecard, "releaseDecision" | "gatesPassed">): RealtimeScorecard {
  const gatesPassed = input.executedCases > 0 && input.failures.length === 0 && input.confirmedDuplicates === 0 && input.rollbackCount === 0;
  return { ...input, gatesPassed, releaseDecision: gatesPassed ? "manual-review" : "keep-cli" };
}
