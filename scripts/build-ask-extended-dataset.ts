// 构建扩样问答评测集：从冻结转写片段（video-reimport 报告）派生知识型问题。
// 复现 ask-extended-v1（2026-08-30-video-derived-40q）的数据口径：
//   - question + termHint + topic 由本地 llama 依据真实转写片段生成（temperature 0）
//   - 不带 recentTranscript（与 v1 一致，保持与旧基线可比）
//   - cacheMode 冷热各半、交替分配
// 用法：npx tsx scripts/build-ask-extended-dataset.ts
// 环境变量：ASK_DATASET_TRANSCRIPTS_DIR / ASK_DATASET_TARGET / ASK_DATASET_OUTPUT /
//           LLAMA_BASE_URL / LLAMA_MODEL
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TRANSCRIPTS_DIR = resolve(
  process.env.ASK_DATASET_TRANSCRIPTS_DIR ??
    "reports/video-reimport-20260830-cuda-zh/transcripts",
);
const TARGET = Number(process.env.ASK_DATASET_TARGET ?? "160");
const OUTPUT = resolve(
  process.env.ASK_DATASET_OUTPUT ?? "fixtures/ask-extended-v2.json",
);
const BASE_URL = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8082";
const MODEL =
  process.env.LLAMA_MODEL ?? "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf";

const SEGMENTS_PER_BATCH = 6;
const QUESTIONS_PER_BATCH = 4;
const MIN_SEGMENT_CHARS = 40;
const MAX_BATCH_CHARS = 1800;
const CALL_TIMEOUT_MS = 60_000;

interface TranscriptSegment {
  video: string;
  fromSec: number;
  text: string;
}

interface GeneratedQuestion {
  question: string;
  termHint: string;
  topic: string;
}

async function loadSegments(dir: string): Promise<TranscriptSegment[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no transcript JSON files under ${dir}`);
  const segments: TranscriptSegment[] = [];
  for (const name of files) {
    const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      video?: unknown;
      transcription?: Array<{ offsets?: { from?: unknown }; text?: unknown }>;
    };
    if (typeof raw.video !== "string" || !Array.isArray(raw.transcription)) continue;
    for (const segment of raw.transcription) {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      const from = segment.offsets?.from;
      if (text.length < MIN_SEGMENT_CHARS) continue;
      segments.push({
        video: raw.video,
        fromSec: typeof from === "number" ? Math.round(from / 1000) : 0,
        text,
      });
    }
  }
  return segments;
}

function buildBatches(segments: TranscriptSegment[]): Array<{ video: string; fromSec: number; text: string }> {
  const batches: Array<{ video: string; fromSec: number; text: string }> = [];
  let current: TranscriptSegment[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      video: current[0].video,
      fromSec: current[0].fromSec,
      text: current.map((s) => s.text).join(" ").slice(0, MAX_BATCH_CHARS),
    });
    current = [];
  };
  for (const segment of segments) {
    if (current.length > 0 && current[0].video !== segment.video) flush();
    current.push(segment);
    if (current.length >= SEGMENTS_PER_BATCH) flush();
  }
  flush();
  return batches;
}

async function generateQuestions(batch: { video: string; text: string }): Promise<GeneratedQuestion[]> {
  const system =
    "你是会议助手的评测集构建器。根据给定的会议/课程转写片段，生成会中听众可能向助手提出的知识型问题。" +
    "要求：question 为简体中文、10~60 字、以「？」结尾；termHint 是检索该问题时应使用的技术术语（英文优先，2~6 个单词）；" +
    "topic 为 2~4 个英文单词的小写主题（如 agent-memory）。只输出 JSON：" +
    '{"questions":[{"question":"...","termHint":"...","topic":"..."}]}。' +
    "只基于片段中明确出现的技术概念出题，最多 " +
    `${QUESTIONS_PER_BATCH} 个问题；不要臆造片段中没有的术语。`;
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `转写片段（视频 ${batch.video}）：\n${batch.text}` },
      ],
      temperature: 0,
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`llama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("empty completion");
  const parsed = JSON.parse(content) as { questions?: unknown };
  if (!Array.isArray(parsed.questions)) throw new Error("missing questions array");
  const questions: GeneratedQuestion[] = [];
  for (const item of parsed.questions) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const termHint = typeof record.termHint === "string" ? record.termHint.trim() : "";
    const topic = typeof record.topic === "string" ? record.topic.trim() : "";
    if (question.length < 8 || question.length > 80 || !question.endsWith("？")) continue;
    if (termHint.length < 2 || termHint.length > 60) continue;
    questions.push({ question, termHint, topic: /^[a-z0-9-]+$/.test(topic) ? topic : "general" });
  }
  return questions;
}

async function main(): Promise<void> {
  console.log(`loading transcripts from ${TRANSCRIPTS_DIR}`);
  const segments = await loadSegments(TRANSCRIPTS_DIR);
  const batches = buildBatches(segments);
  console.log(`segments=${segments.length} batches=${batches.length} target=${TARGET}`);

  const seenQuestions = new Set<string>();
  const seenTermHints = new Set<string>();
  const questions: Array<Record<string, unknown>> = [];
  let batchFailures = 0;

  outer: for (const [batchIndex, batch] of batches.entries()) {
    let generated: GeneratedQuestion[] | null = null;
    for (let attempt = 0; attempt < 2 && generated === null; attempt += 1) {
      try {
        generated = await generateQuestions(batch);
      } catch (error) {
        console.warn(`batch ${batchIndex} attempt ${attempt} failed: ${String(error)}`);
      }
    }
    if (generated === null) {
      batchFailures += 1;
      continue;
    }
    for (const item of generated) {
      if (questions.length >= TARGET) break outer;
      const questionKey = item.question.replace(/\s+/g, "");
      const termKey = item.termHint.toLowerCase();
      if (seenQuestions.has(questionKey) || seenTermHints.has(termKey)) continue;
      seenQuestions.add(questionKey);
      seenTermHints.add(termKey);
      const index = questions.length;
      const cacheMode = index % 2 === 0 ? "cold" : "hot";
      questions.push({
        id: `e${String(index + 1).padStart(3, "0")}${cacheMode === "cold" ? "c" : "h"}`,
        question: item.question,
        termHint: item.termHint,
        topic: item.topic,
        tags: ["keyword-extraction"],
        sourceVideo: batch.video,
        sourceTimeSec: batch.fromSec,
        cacheMode,
      });
    }
    if (questions.length % 20 === 0) console.log(`progress: ${questions.length}/${TARGET}`);
  }

  if (questions.length < TARGET) {
    throw new Error(`only built ${questions.length}/${TARGET} questions (${batchFailures} batch failures)`);
  }
  const cold = questions.filter((q) => q.cacheMode === "cold").length;
  const fixture = {
    version: "2026-09-07-video-derived-160q",
    datasetVersion: "2026-09-07-video-derived-160q",
    dataSource: `frozen zh transcripts under ${TRANSCRIPTS_DIR} (video-reimport-20260830-cuda-zh); questions drafted by local Qwen3-8B from real segments at temperature 0`,
    authorizationNote:
      "Derived from locally imported video transcripts for evaluation only; single-user research workload.",
    questions,
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + "\n", "utf8");
  console.log(`wrote ${questions.length} questions (cold=${cold}, hot=${questions.length - cold}) to ${OUTPUT}; batchFailures=${batchFailures}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
