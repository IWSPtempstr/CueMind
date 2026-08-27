import assert from "node:assert/strict";
import { validateDemoLedger } from "@/scripts/validate-replay";

interface DemoLedgerRecord {
  candidateId: string;
  traceId: string;
  finalState?: "card_shown" | "excluded_unscorable";
}

function record(
  candidateId: string,
  traceId: string,
  finalState: DemoLedgerRecord["finalState"] = "card_shown",
): DemoLedgerRecord {
  return { candidateId, traceId, finalState };
}

const validLedger: DemoLedgerRecord[] = [
  record("candidate-1", "trace-1"),
  record("candidate-2", "trace-2"),
];

assert.equal(validateDemoLedger(validLedger).valid, true);
assert.equal(validateDemoLedger([
  record("candidate-1", "trace-1"),
  record("candidate-1", "trace-2"),
]).valid, false);
assert.equal(validateDemoLedger([
  record("candidate-1", "trace-1"),
  record("candidate-2", "trace-1"),
]).valid, false);
assert.equal(validateDemoLedger([
  { candidateId: "candidate-1", traceId: "trace-1" },
]).valid, false);
assert.equal(validateDemoLedger([
  record("candidate-excluded", "trace-1", "excluded_unscorable"),
  record("candidate-shown", "trace-2", "card_shown"),
]).valid, true);

console.log("demo ledger tests passed");
