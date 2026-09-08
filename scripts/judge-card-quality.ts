// Card content-quality judge (offline, local llama as the judge; no outbound network).
//
// Reads a context-card evaluation cases.jsonl (rows produced with card capture:
// card.keyword/explanation/whyNow + usableSourceTitles) and scores each generated
// card on:
//   - relevance:    does the card explain the term in the transcript context
//   - faithfulness: claims plausibly grounded in the cited source titles (title-level heuristic)
//   - readability:  compact, scannable within a live meeting
//
// Usage: CARD_EVAL_CASES=reports/<dir>/cases.jsonl npx tsx scripts/judge-card-quality.ts
// Output: reports/card-quality/report-<ts>.md

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const BASE_URL = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8082";
const MODEL = process.env.LLAMA_MODEL ?? "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf";
const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS ?? "60000");

interface JudgeCard {
  id: string;
  keyword: string;
  explanation: string;
  whyNow: string;
  sourceTitles: string[];
  transcriptExcerpt: string;
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

async function judgeOnce(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
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
  "你是会议知识卡片质量的评审员。给定卡片（术语/解释/为何现在）、引用来源标题与出现该术语的转写片段，按三个维度打 1-5 分并给一句理由：",
  "relevance：卡片是否解释了转写语境中的该术语（而非泛泛而谈别的主题）；faithfulness：卡片论断是否与所引来源标题一致（仅有标题，做一致性启发判断）；readability：会议中秒读是否友好（紧凑、结构清晰、无冗长铺垫）。",
  "只输出 JSON：{\"relevance\":{\"score\":1-5,\"reason\":\"...\"},\"faithfulness\":{...},\"readability\":{...}}",
].join("\n");

async function loadCards(path: string): Promise<JudgeCard[]> {
  const lines = (await readFile(resolve(path), "utf8")).split("\n").filter((line) => line.trim() !== "");
  const cards: JudgeCard[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const card = row.card;
      if (typeof card !== "object" || card === null) continue;
      const record = card as Record<string, unknown>;
      if (typeof record.keyword !== "string" || typeof record.explanation !== "string" || record.explanation.trim() === "") continue;
      cards.push({
        id: typeof row.id === "string" ? row.id : `card-${cards.length}`,
        keyword: record.keyword,
        explanation: record.explanation,
        whyNow: typeof record.whyNow === "string" ? record.whyNow : "",
        sourceTitles: Array.isArray(row.usableSourceTitles) ? (row.usableSourceTitles as unknown[]).filter((t): t is string => typeof t === "string") : [],
        transcriptExcerpt: typeof row.transcriptExcerpt === "string" ? row.transcriptExcerpt.slice(0, 600) : "",
      });
    } catch { /* skip malformed line */ }
  }
  return cards;
}

function formatDistribution(scores: number[]): string {
  const buckets = new Map<number, number>();
  for (const score of scores) buckets.set(score, (buckets.get(score) ?? 0) + 1);
  return [1, 2, 3, 4, 5].map((score) => `${score}★:${buckets.get(score) ?? 0}`).join("  ");
}

async function main(): Promise<void> {
  const casesPath = process.env.CARD_EVAL_CASES;
  if (!casesPath) throw new Error("CARD_EVAL_CASES is required (path to card eval cases.jsonl)");
  const cards = await loadCards(casesPath);
  if (cards.length === 0) throw new Error("no judgeable cards found (card capture missing in cases.jsonl?)");

  const verdicts: { judgeCard: JudgeCard; verdict: JudgeVerdict | null; error: string | null }[] = [];
  for (const judgeCard of cards) {
    const userPrompt = [
      `术语：${judgeCard.keyword}`,
      `卡片解释：${judgeCard.explanation}`,
      `为何现在：${judgeCard.whyNow}`,
      `引用来源标题：${judgeCard.sourceTitles.length > 0 ? judgeCard.sourceTitles.join("；") : "（无）"}`,
      `转写片段：${judgeCard.transcriptExcerpt || "（未提供）"}`,
    ].join("\n");
    try {
      const raw = await judgeOnce(JUDGE_SYSTEM_PROMPT, userPrompt);
      const verdict = parseVerdict(raw);
      verdicts.push({ judgeCard, verdict, error: verdict === null ? "unparseable judge output" : null });
    } catch (error) {
      verdicts.push({ judgeCard, verdict: null, error: error instanceof Error ? error.message : String(error) });
    }
    process.stdout.write(`judged ${verdicts.length}/${cards.length}\r`);
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
    "# Card Content Quality Judge Report",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Judge model: ${MODEL} (local, temperature 0)`,
    `- Cards: ${cards.length} judged, ${ok.length} parsed, ${verdicts.length - ok.length} errors`,
    "",
    "| Dimension | Avg | Distribution |",
    "|---|---|---|",
    `| relevance | ${avg("relevance")} | ${formatDistribution(ok.map((e) => e.verdict!.relevance.score))} |`,
    `| faithfulness (title-level heuristic) | ${avg("faithfulness")} | ${formatDistribution(ok.map((e) => e.verdict!.faithfulness.score))} |`,
    `| readability | ${avg("readability")} | ${formatDistribution(ok.map((e) => e.verdict!.readability.score))} |`,
    "",
    "## Low scores (relevance or faithfulness <= 2)",
    "",
    lowScores.length === 0 ? "_None._" : lowScores.map((entry) => `### ${entry.judgeCard.id} (${entry.judgeCard.keyword})\n\n- relevance ${entry.verdict!.relevance.score}: ${entry.verdict!.relevance.reason}\n- faithfulness ${entry.verdict!.faithfulness.score}: ${entry.verdict!.faithfulness.reason}`).join("\n\n"),
    "",
    "## Errors",
    "",
    errorCounts.size === 0 ? "_None._" : [...errorCounts.entries()].map(([message, count]) => `- ${count}x: ${message}`).join("\n"),
    "",
    "> faithfulness is a title-level consistency heuristic; full grounding checks need source excerpts persisted alongside cards.",
  ];

  const outputDir = resolve("reports/card-quality");
  await mkdir(outputDir, { recursive: true });
  const outPath = resolve(outputDir, `report-${Date.now()}.md`);
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`card quality report written: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
