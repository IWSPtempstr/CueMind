// Content-quality judge (offline, local llama as the judge; no outbound network).
//
// Scores sampled Q&A turns on three dimensions the latency metrics cannot see:
//   - relevance:    does the answer address the question asked
//   - faithfulness: are claims plausibly grounded in the cited sources (title-level
//                   heuristic — source excerpts are not persisted, so this checks
//                   answer/citation consistency, not full grounding)
//   - readability:  is the answer compact and scannable for a live meeting
//
// Inputs (either):
//   ASK_EVAL_CASES  : comma-separated paths to eval cases.jsonl files (rows need
//                     question + answer; rows without a non-empty answer are skipped)
//   --from-store    : fall back to chat_messages pairs from .data/cuemind.db
// Output: reports/content-quality/report-<ts>.md with score distribution and low scores.
//
// Usage: npx tsx scripts/judge-content-quality.ts [--limit 30]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3") as new (
  path: string,
  options?: { readonly: boolean; fileMustExist: boolean },
) => {
  prepare: (sql: string) => { all: () => unknown[] };
  close: () => void;
};

const BASE_URL = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8082";
const MODEL = process.env.LLAMA_MODEL ?? "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf";
const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS ?? "60000");

interface JudgeCase {
  id: string;
  origin: string;
  question: string;
  answer: string;
  sources: { title: string; url: string }[];
  keywords: string[];
  finalState: string;
}

interface DimensionVerdict {
  score: number;
  reason: string;
}

interface JudgeVerdict {
  relevance: DimensionVerdict;
  faithfulness: DimensionVerdict;
  readability: DimensionVerdict;
}

function clampScore(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(5, Math.max(1, Math.round(value))) : null;
}

function parseVerdict(raw: string): JudgeVerdict | null {
  try {
    // The local model sometimes double-encodes the JSON object as a JSON string.
    let data = JSON.parse(raw) as unknown;
    if (typeof data === "string") data = JSON.parse(data) as unknown;
    const record = data as Record<string, unknown>;
    const dimension = (name: string): DimensionVerdict | null => {
      const entry = record[name];
      if (typeof entry !== "object" || entry === null) return null;
      const entryRecord = entry as Record<string, unknown>;
      const score = clampScore(entryRecord.score);
      if (score === null) return null;
      return { score, reason: typeof entryRecord.reason === "string" ? entryRecord.reason.slice(0, 300) : "" };
    };
    const relevance = dimension("relevance");
    const faithfulness = dimension("faithfulness");
    const readability = dimension("readability");
    if (!relevance || !faithfulness || !readability) return null;
    return { relevance, faithfulness, readability };
  } catch {
    return null;
  }
}

async function judgeOnce(model: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("empty judge output");
  return content;
}

const JUDGE_SYSTEM_PROMPT = [
  "你是会议知识助手回答质量的评审员。给定问题、回答与引用来源标题，按三个维度打 1-5 分并给一句理由：",
  "relevance：回答是否切题并解决提问；faithfulness：回答的论断是否与所引来源标题一致、引用是否可对应（注意：仅有标题，做的是一致性启发判断）；readability：会议中秒读是否友好（紧凑、有结构、无冗长铺垫）。",
  "只输出 JSON：{\"relevance\":{\"score\":1-5,\"reason\":\"...\"},\"faithfulness\":{...},\"readability\":{...}}",
].join("\n");

async function loadCasesFromFiles(paths: string[], limit: number): Promise<JudgeCase[]> {
  const cases: JudgeCase[] = [];
  for (const path of paths) {
    const lines = (await readFile(resolve(path), "utf8")).split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.question !== "string" || typeof row.answer !== "string" || row.answer.trim() === "") continue;
        cases.push({
          id: typeof row.id === "string" ? row.id : `case-${cases.length}`,
          origin: path,
          question: row.question,
          answer: row.answer,
          sources: Array.isArray(row.sources)
            ? (row.sources as { title?: unknown; url?: unknown }[]).filter((s) => typeof s?.title === "string" && typeof s?.url === "string").map((s) => ({ title: s.title as string, url: s.url as string }))
            : [],
          keywords: Array.isArray(row.keywords) ? (row.keywords as unknown[]).filter((k): k is string => typeof k === "string") : [],
          finalState: typeof row.finalState === "string" ? row.finalState : "",
        });
      } catch { /* skip malformed line */ }
    }
  }
  return cases.slice(0, limit);
}

async function loadCasesFromStore(limit: number): Promise<JudgeCase[]> {
  const dataDir = resolve(process.env.CUEMIND_DATA_DIR ?? join(process.cwd(), ".data"));
  const db = new Database(join(dataDir, "cuemind.db"), { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT id, session_id, role, content, sources_json, keywords_json, final_state, created_at FROM chat_messages ORDER BY created_at ASC, rowid ASC").all() as unknown as {
    id: string; session_id: string; role: string; content: string; sources_json: string | null; keywords_json: string | null; final_state: string | null; created_at: string;
  }[];
  db.close();

  const parseJsonArray = (raw: string | null): unknown[] => {
    try {
      const parsed = JSON.parse(raw ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const cases: JudgeCase[] = [];
  for (let index = 0; index < rows.length - 1; index += 1) {
    const user = rows[index];
    const assistant = rows[index + 1];
    if (user.role !== "user" || assistant.role !== "assistant" || user.session_id !== assistant.session_id) continue;
    if (assistant.content.trim() === "") continue;
    cases.push({
      id: `store-${assistant.id}`,
      origin: `store:${user.session_id}`,
      question: user.content,
      answer: assistant.content,
      sources: parseJsonArray(assistant.sources_json).filter((s): s is { title: string; url: string } => typeof s === "object" && s !== null && typeof (s as { title?: unknown }).title === "string" && typeof (s as { url?: unknown }).url === "string"),
      keywords: parseJsonArray(assistant.keywords_json).filter((k): k is string => typeof k === "string"),
      finalState: assistant.final_state ?? "",
    });
    index += 1;
    if (cases.length >= limit) break;
  }
  return cases;
}

function formatDistribution(scores: number[]): string {
  const buckets = new Map<number, number>();
  for (const score of scores) buckets.set(score, (buckets.get(score) ?? 0) + 1);
  return [1, 2, 3, 4, 5].map((score) => `${score}★:${buckets.get(score) ?? 0}`).join("  ");
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 && Number.isFinite(Number(process.argv[limitArg + 1])) ? Number(process.argv[limitArg + 1]) : 30;
  const casesArg = process.env.ASK_EVAL_CASES;
  const cases = casesArg
    ? await loadCasesFromFiles(casesArg.split(",").map((p) => p.trim()).filter(Boolean), limit)
    : await loadCasesFromStore(limit);
  if (cases.length === 0) {
    console.error("no judgeable cases found (answers missing?). Run the evaluator with answer capture first, or pass ASK_EVAL_CASES.");
    process.exit(1);
  }

  const verdicts: { judgeCase: JudgeCase; verdict: JudgeVerdict | null; error: string | null }[] = [];
  for (const judgeCase of cases) {
    const userPrompt = [
      `问题：${judgeCase.question}`,
      `回答：${judgeCase.answer}`,
      `引用来源：${judgeCase.sources.length > 0 ? judgeCase.sources.map((s) => s.title).join("；") : "（无）"}`,
    ].join("\n");
    try {
      const raw = await judgeOnce(MODEL, JUDGE_SYSTEM_PROMPT, userPrompt);
      verdicts.push({ judgeCase, verdict: parseVerdict(raw), error: parseVerdict(raw) === null ? "unparseable judge output" : null });
    } catch (error) {
      verdicts.push({ judgeCase, verdict: null, error: error instanceof Error ? error.message : String(error) });
    }
    process.stdout.write(`judged ${verdicts.length}/${cases.length}\r`);
  }
  process.stdout.write("\n");

  const ok = verdicts.filter((entry) => entry.verdict !== null);
  const avg = (dimension: keyof JudgeVerdict): string => {
    const scores = ok.map((entry) => entry.verdict![dimension].score);
    return scores.length === 0 ? "n/a" : (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2);
  };
  const lowScores = ok
    .filter((entry) => entry.verdict!.relevance.score <= 2 || entry.verdict!.faithfulness.score <= 2)
    .slice(0, 10);
  const errorCounts = new Map<string, number>();
  for (const entry of verdicts) {
    if (entry.error !== null) errorCounts.set(entry.error, (errorCounts.get(entry.error) ?? 0) + 1);
  }

  const lines: string[] = [
    "# Content Quality Judge Report",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Judge model: ${MODEL} (local, temperature 0)`,
    `- Cases: ${cases.length} judged, ${ok.length} parsed, ${verdicts.length - ok.length} errors`,
    "",
    "| Dimension | Avg | Distribution |",
    "|---|---|---|",
    `| relevance | ${avg("relevance")} | ${formatDistribution(ok.map((e) => e.verdict!.relevance.score))} |`,
    `| faithfulness (title-level heuristic) | ${avg("faithfulness")} | ${formatDistribution(ok.map((e) => e.verdict!.faithfulness.score))} |`,
    `| readability | ${avg("readability")} | ${formatDistribution(ok.map((e) => e.verdict!.readability.score))} |`,
    "",
    "## Low scores (relevance or faithfulness <= 2)",
    "",
    lowScores.length === 0 ? "_None._" : lowScores.map((entry) => `### ${entry.judgeCase.id} (${entry.judgeCase.origin})\n\nQ: ${entry.judgeCase.question}\n\n- relevance ${entry.verdict!.relevance.score}: ${entry.verdict!.relevance.reason}\n- faithfulness ${entry.verdict!.faithfulness.score}: ${entry.verdict!.faithfulness.reason}`).join("\n\n"),
    "",
    "> faithfulness is a title-level consistency heuristic: source excerpts are not persisted, so full grounding checks need answer capture to also store source snippets.",
    "",
    "## Errors",
    "",
    errorCounts.size === 0 ? "_None._" : [...errorCounts.entries()].map(([message, count]) => `- ${count}x: ${message}`).join("\n"),
  ];

  const outputDir = resolve("reports/content-quality");
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, `report-${Date.now()}.md`);
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`content quality report written: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
