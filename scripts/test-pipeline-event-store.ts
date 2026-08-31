import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendPipelineEvents, parsePipelineEvents } from "@/lib/pipeline-event-store";

const events = parsePipelineEvents([
  { runId: "run-1", name: "capture_start", atMs: 1, metadata: { source: "microphone", transcript: "private" } },
  { runId: "run-1", name: "capture_end", atMs: 2, metadata: { status: "ok", apiKey: "private" } },
]);
assert.ok(events);
assert.equal(events[0].metadata?.source, "microphone");
assert.equal(Object.prototype.hasOwnProperty.call(events[0].metadata ?? {}, "transcript"), false);
assert.equal(parsePipelineEvents([{ runId: "run-1", name: "capture_start", atMs: 2 }, { runId: "run-1", name: "capture_start", atMs: 3 }]), null);
const file = path.join(mkdtempSync(path.join(os.tmpdir(), "cuemind-events-")), "events.jsonl");
appendPipelineEvents(events, file);
assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
console.log("pipeline event store tests passed");
