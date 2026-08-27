import assert from "node:assert/strict";
import {
  buildDemoCandidateWindows,
  type DemoTranscriptChunk,
} from "@/lib/replay";

const options = {
  datasetVersion: "demo-manifest-v1",
  mediaId: "meeting-claude-agent-talk",
  asrVersion: "whisper.cpp 1.9.3-dev + ggml-small.bin",
  windowingVersion: "candidate-window-v1",
  minimumDurationMs: 2_000,
  contextOverlapMs: 2_000,
  maximumDurationMs: 12_000,
};

function chunk(
  id: string,
  startMs: number,
  endMs: number,
  sentenceBoundary = false,
): DemoTranscriptChunk {
  return { id, startMs, endMs, text: `chunk ${id}`, sentenceBoundary };
}

function testSentenceBoundaryClosure(): void {
  const windows = buildDemoCandidateWindows([
    chunk("sentence-1", 10_000, 11_000),
    chunk("sentence-2", 11_000, 12_400, true),
    chunk("after-boundary", 12_400, 13_200),
  ], options);

  assert.deepEqual(windows[0], {
    coreStartMs: 10_000,
    coreEndMs: 12_400,
    contextStartMs: 8_000,
    contextEndMs: 12_400,
    transcriptChunkIds: ["sentence-1", "sentence-2"],
    windowCloseReason: "sentence_end",
    candidateIdInputs: {
      datasetVersion: "demo-manifest-v1",
      mediaId: "meeting-claude-agent-talk",
      coreStartMs: 10_000,
      coreEndMs: 12_400,
      asrVersion: "whisper.cpp 1.9.3-dev + ggml-small.bin",
      windowingVersion: "candidate-window-v1",
    },
  });
}

function testMinimumAccumulationBeforeSentenceClosure(): void {
  const windows = buildDemoCandidateWindows([
    chunk("short-1", 20_000, 20_700),
    chunk("short-sentence", 20_700, 21_400, true),
    chunk("minimum-2", 21_400, 22_100),
    chunk("minimum-3", 22_100, 22_600, true),
  ], options);

  assert.equal(windows[0].coreStartMs, 20_000);
  assert.equal(windows[0].coreEndMs, 22_600);
  assert.equal(windows[0].windowCloseReason, "sentence_end");
  assert.deepEqual(windows[0].transcriptChunkIds, [
    "short-1",
    "short-sentence",
    "minimum-2",
    "minimum-3",
  ]);
}

function testTwoSecondContextOverlap(): void {
  const windows = buildDemoCandidateWindows([
    chunk("first", 30_000, 33_000, true),
    chunk("second", 33_000, 36_000, true),
  ], options);

  assert.equal(windows[1].contextStartMs, 31_000);
  assert.equal(windows[1].contextEndMs, 36_000);
  assert.equal(windows[1].coreStartMs, 33_000);
  assert.equal(windows[1].coreEndMs, 36_000);
}

function testTwelveSecondMaximum(): void {
  const windows = buildDemoCandidateWindows([
    chunk("max-1", 40_000, 46_000),
    chunk("max-2", 46_000, 52_000),
    chunk("max-3", 52_000, 55_000),
  ], options);

  assert.equal(windows[0].coreStartMs, 40_000);
  assert.equal(windows[0].coreEndMs, 52_000);
  assert.equal(windows[0].contextStartMs, 38_000);
  assert.equal(windows[0].windowCloseReason, "max_duration");
}

function testEndOfInputClosure(): void {
  const windows = buildDemoCandidateWindows([
    chunk("tail-1", 60_000, 61_000),
    chunk("tail-2", 61_000, 63_500),
  ], options);

  assert.equal(windows[0].coreStartMs, 60_000);
  assert.equal(windows[0].coreEndMs, 63_500);
  assert.equal(windows[0].windowCloseReason, "end_of_input");
}

function testContextOverlapDoesNotCreateDuplicateCoreCandidate(): void {
  const windows = buildDemoCandidateWindows([
    chunk("first-core", 70_000, 73_000, true),
    chunk("overlap-only", 73_000, 74_000),
    chunk("second-core", 74_000, 76_500, true),
  ], options);

  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((window) => window.transcriptChunkIds), [
    ["first-core"],
    ["overlap-only", "second-core"],
  ]);
  assert.notDeepEqual(windows[0].candidateIdInputs, windows[1].candidateIdInputs);
}

testSentenceBoundaryClosure();
testMinimumAccumulationBeforeSentenceClosure();
testTwoSecondContextOverlap();
testTwelveSecondMaximum();
testEndOfInputClosure();
testContextOverlapDoesNotCreateDuplicateCoreCandidate();

console.log("demo windowing tests passed");
