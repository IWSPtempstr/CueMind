import assert from "node:assert/strict";
import { createPostmeetingTranscript } from "@/lib/postmeeting-transcript";
import { redactText } from "@/lib/redaction";
import { buildTimeline } from "@/lib/timeline";

const chunks = [
  { id: "c1", text: "联系 alice@example.com，API key sk-test-1234567890。", timestamp: new Date(0), startMs: 0, endMs: 5000 },
  { id: "c2", text: "张三负责方案。", timestamp: new Date(5000), startMs: 5000, endMs: 9000 },
];

async function run(): Promise<void> {
const polished = await createPostmeetingTranscript(chunks, { polish: async () => "整理后的文本" });
assert.equal(polished.status, "polished");
assert.equal(polished.text, "整理后的文本");
assert.equal(polished.rawHash.length, 64);
assert.equal(chunks[0].text.includes("alice@example.com"), true);

const fallback = await createPostmeetingTranscript(chunks, { polish: async () => { throw new Error("offline"); } });
assert.equal(fallback.status, "fallback_raw");
assert.match(fallback.text, /alice@example.com/);
assert.equal(fallback.failureReason, "offline");

const redacted = redactText("联系 alice@example.com，电话 13812345678。", { dictionary: { PERSON: ["张三"] } });
assert.equal(redacted.text.includes("alice@example.com"), false);
assert.equal(redacted.text.includes("13812345678"), false);
assert.equal(redacted.manifest.manualReviewRequired, true);
assert.equal(Object.values(redacted.manifest).some((value) => String(value).includes("alice@example.com")), false);

const timeline = buildTimeline({ transcriptChunks: chunks, cards: [{ candidateId: "cand-1", startMs: 5000, endMs: 9000 }], asks: [{ id: "ask-1", startMs: 5000, endMs: 9000 }] });
assert.deepEqual(timeline.entries.find((entry) => entry.id === "c1")?.startMs, 0);
assert.equal(timeline.entries.some((entry) => entry.kind === "card" && entry.id === "cand-1"), true);
assert.equal(timeline.entries.some((entry) => entry.kind === "ask" && entry.id === "ask-1"), true);
assert.equal(JSON.stringify(timeline).includes("http"), false);

console.log("postmeeting experience contract red test passed");
}

void run();
