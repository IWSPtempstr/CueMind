import assert from "node:assert/strict";
import { ResidentAsrWorker } from "@/lib/realtime-asr-worker";

async function main(): Promise<void> {
  const worker = new ResidentAsrWorker({ maxQueue: 1, modelHash: "sha256:test", device: "cpu", decode: async (pcm) => ({ text: `${pcm.length}`, startMs: 0, endMs: 100 }) });
  assert.equal(worker.health().modelHash, "sha256:test");
  const first = worker.submit(new Int16Array([1, 2]));
  await assert.rejects(worker.submit(new Int16Array([3])), /queue limit/);
  assert.equal((await first).text, "2");
  assert.equal(worker.health().queueLength, 0);
  await worker.close();
  assert.equal(worker.health().status, "stopped");
  console.log("realtime asr worker assertions passed");
}
void main();
