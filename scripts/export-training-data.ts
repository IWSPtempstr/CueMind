// 主线五（决策 65 轻量档）：离线导出候选账本 + 会话窗口 → SFT 指令对 / DPO 偏好对。
//
// 红线（决策 65）：纯离线脚本——只读本地 SQLite → 本地导出文件；不接任何实时链路，
// 不自动改 Prompt、不动态改权重，模型是否替换由人工评估后决定；DPO「有用」标记来自
// 人工维护的 --useful 文件（人工把关）；不含密钥与原始音频。
//
// 读取白名单：candidates 表整行（账本）+ sessions 表仅 id / transcript_json；
// sessions 的 cards_json / metrics_json / title 等列一律不读；
// chat_messages 表仅取 session_id / role / content（会中询问历史，决策 67 第二通道）。
// 降级/失败回答不参与信号：信号仅匹配 role=user 的问题文本，降级文案均为
// assistant 回答（角色过滤天然排除）；提取层（lib/ask-history）亦跳过降级回答。
//
// 用法：npx tsx scripts/export-training-data.ts [--data-dir <dir>] [--out <dir>] [--useful <json-file>] [--now <iso>]
// - --data-dir 默认 process.env.CUEMIND_DATA_DIR || <cwd>/.data
// - --out      默认 <data-dir>/training-export
// - --useful   可选 JSON 文件（string[] candidateId 列表）；缺省 → 空集合（DPO 为空）
// - --now      可选导出时间（ISO）；测试注入固定值以保证字节级幂等

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";

export interface CandidateRow {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  createdAt: string;
}

/** 会话读取白名单：仅 id + transcript_json（cards_json/metrics_json 不读）。 */
export interface SessionRow {
  id: string;
  transcriptJson: string;
}

/** 会中询问历史读取白名单：chat_messages 仅取 session_id / role / content。 */
export interface ChatMessageRow {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
}

/** 会中询问信号统计（决策 65 第二通道）。 */
export interface AskSignalStats {
  /** model_skip 候选 term 被询问命中 → 漏报 DPO 对数量。 */
  missedTriggerDpo: number;
  /** card_shown 候选 term 仍被询问 → 卡片解释质量不足。 */
  cardExplanationInsufficient: number;
}

export interface SftPair {
  sessionId: string;
  candidateId: string;
  windowText: string;
  term: string | null;
  label: string;
  split: "train" | "eval";
}

export interface DpoPair {
  sessionId: string;
  candidateId: string;
  windowText: string;
  term: string;
  chosen: string;
  rejected: string;
  split: "train" | "eval";
}

export interface TrainingExport {
  sft: SftPair[];
  dpo: DpoPair[];
  failureStats: Record<string, number>;
  askSignalStats: AskSignalStats;
  splitMap: Record<string, "train" | "eval">;
  generatedAt: string;
}

/** 7 类终态（failureStats 固定键序；账本中的其他终态不计入统计但照常进 SFT）。 */
export const FINAL_STATES = [
  "card_shown",
  "model_skip",
  "suppressed_as_duplicate",
  "search_failed",
  "model_failed",
  "invalid_schema",
  "invalid_request",
] as const;

const WINDOW_SIZE = 8;
const SQLITE_DB_FILE = "cuemind.db";

// Static-side type for better-sqlite3（与 lib/session-store.ts 同一约定）。
type SqliteDatabaseConstructor = new (
  dbPath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

/** 按 session 切分：sha256(sessionId) 首字节 % 5 === 0 → eval（约 20%，确定性 → 幂等）。 */
export function splitOf(sessionId: string): "train" | "eval" {
  const firstByte = createHash("sha256").update(sessionId).digest()[0];
  return firstByte % 5 === 0 ? "eval" : "train";
}

/** 固定 instruction 模板（sft.jsonl 的 instruction 与 dpo.jsonl 的 prompt 共用）。 */
function buildInstruction(term: string, windowText: string): string {
  return `判断以下会议窗口是否应提示关键词「${term}」。\n窗口文本：\n${windowText}`;
}

/**
 * 窗口文本重建：取 ≤ candidate.createdAt 的 chunks（按 transcript 原序），最后 8 条 join("\n")。
 * transcript 解析失败 / 无 chunk / 无合法 timestamp → ""。
 */
function buildWindowText(transcriptJson: string, createdAt: string): string {
  const cutoff = Date.parse(createdAt);
  if (Number.isNaN(cutoff)) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(transcriptJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const texts: string[] = [];
  for (const chunk of parsed) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const record = chunk as Record<string, unknown>;
    const text = record.text;
    const timestamp = record.timestamp;
    if (typeof text !== "string" || typeof timestamp !== "string") continue;
    const at = Date.parse(timestamp);
    if (Number.isNaN(at) || at > cutoff) continue;
    texts.push(text);
  }
  return texts.slice(-WINDOW_SIZE).join("\n");
}

/** 询问提取词命中规则：用户问题（大小写不敏感）包含候选 term → 视为命中。 */
function questionMentionsTerm(question: string, term: string): boolean {
  const normalizedQuestion = question.toLowerCase();
  const normalizedTerm = term.trim().toLowerCase();
  return normalizedTerm.length >= 2 && normalizedQuestion.includes(normalizedTerm);
}

/**
 * 纯函数数据组装（导出供测试）：
 * - SFT：所有 term != null 的 candidate 各一条（终态即标签，7 类全收；空窗口仍导出）。
 * - DPO：final_state === "model_skip" 且 candidateId ∈ usefulIds 且 term != null → 漏报构造
 *   （chosen/rejected 为决策轨迹文本，轻量档不重建完整 trace）。
 * - DPO 第二通道（决策 67）：model_skip 候选 term 被会中询问命中 → 漏报 DPO 对
 *   （rejected=trigger:false 实际输出，chosen=trigger:true + term）；card_shown 候选
 *   term 仍被询问 → 计入「卡片解释质量不足」统计信号（不直接造偏好对）。
 * - 行序稳定排序 (sessionId, created_at, candidateId) → 同输入字节级幂等。
 */
export function buildTrainingExport(args: {
  candidates: CandidateRow[];
  sessions: SessionRow[];
  chatMessages?: ChatMessageRow[];
  usefulIds: Set<string>;
  now?: string;
}): TrainingExport {
  const generatedAt = args.now ?? new Date().toISOString();
  const sessionById = new Map<string, SessionRow>();
  for (const session of args.sessions) sessionById.set(session.id, session);

  // 会中询问历史：sessionId → 用户问题列表（仅 role=user 非空内容）。
  const questionsBySession = new Map<string, string[]>();
  for (const message of args.chatMessages ?? []) {
    if (message.role !== "user") continue;
    const question = message.content.trim();
    if (question === "") continue;
    const list = questionsBySession.get(message.sessionId);
    if (list !== undefined) list.push(question);
    else questionsBySession.set(message.sessionId, [question]);
  }

  const sorted = [...args.candidates].sort((a, b) => {
    const bySession = a.sessionId.localeCompare(b.sessionId);
    if (bySession !== 0) return bySession;
    const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.candidateId.localeCompare(b.candidateId);
  });

  const sft: SftPair[] = [];
  const dpo: DpoPair[] = [];
  const askSignalStats: AskSignalStats = { missedTriggerDpo: 0, cardExplanationInsufficient: 0 };
  const splitMap: Record<string, "train" | "eval"> = {};
  for (const candidate of sorted) {
    const split = splitOf(candidate.sessionId);
    splitMap[candidate.sessionId] = split;
    const session = sessionById.get(candidate.sessionId);
    const windowText = session !== undefined ? buildWindowText(session.transcriptJson, candidate.createdAt) : "";
    if (candidate.term !== null) {
      sft.push({
        sessionId: candidate.sessionId,
        candidateId: candidate.candidateId,
        windowText,
        term: candidate.term,
        label: candidate.finalState,
        split,
      });
    }
    const askedAbout =
      candidate.term !== null &&
      (questionsBySession.get(candidate.sessionId) ?? []).some((question) =>
        questionMentionsTerm(question, candidate.term as string),
      );
    const manuallyUseful = candidate.finalState === "model_skip" && candidate.term !== null && args.usefulIds.has(candidate.candidateId);
    if (manuallyUseful) {
      const term = candidate.term as string;
      dpo.push({
        sessionId: candidate.sessionId,
        candidateId: candidate.candidateId,
        windowText,
        term,
        chosen: `应提示关键词「${term}」（用户标记有用）`,
        rejected: "不提示（model_skip）",
        split,
      });
    }
    if (!manuallyUseful && candidate.finalState === "model_skip" && candidate.term !== null && askedAbout) {
      dpo.push({
        sessionId: candidate.sessionId,
        candidateId: candidate.candidateId,
        windowText,
        term: candidate.term,
        chosen: `应提示关键词「${candidate.term}」（会中询问命中）`,
        rejected: "不提示（model_skip）",
        split,
      });
      askSignalStats.missedTriggerDpo += 1;
    }
    if (candidate.finalState === "card_shown" && candidate.term !== null && askedAbout) {
      askSignalStats.cardExplanationInsufficient += 1;
    }
  }

  const failureStats: Record<string, number> = {};
  for (const state of FINAL_STATES) failureStats[state] = 0;
  for (const candidate of args.candidates) {
    if (Object.prototype.hasOwnProperty.call(failureStats, candidate.finalState)) {
      failureStats[candidate.finalState] += 1;
    }
  }

  return { sft, dpo, failureStats, askSignalStats, splitMap, generatedAt };
}

// --- 输出渲染（确定性 → 幂等）---

function toJsonl(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function renderSftJsonl(exported: TrainingExport): string {
  return toJsonl(
    exported.sft.map((pair) => ({
      instruction: buildInstruction(pair.term as string, pair.windowText),
      output: pair.label,
      sessionId: pair.sessionId,
      candidateId: pair.candidateId,
      split: pair.split,
    })),
  );
}

function renderDpoJsonl(exported: TrainingExport): string {
  return toJsonl(
    exported.dpo.map((pair) => ({
      prompt: buildInstruction(pair.term, pair.windowText),
      chosen: pair.chosen,
      rejected: pair.rejected,
      sessionId: pair.sessionId,
      candidateId: pair.candidateId,
      split: pair.split,
    })),
  );
}

function renderSplitJson(exported: TrainingExport): string {
  return `${JSON.stringify(exported.splitMap, null, 2)}\n`;
}

function countEmptyWindows(pairs: Array<{ windowText: string }>): number {
  return pairs.filter((pair) => pair.windowText === "").length;
}

function renderReport(
  exported: TrainingExport,
  input: { candidateCount: number; sessionCount: number },
): string {
  const total = input.candidateCount;
  const lines: string[] = [];
  lines.push("# CueMind 训练数据导出报告");
  lines.push("");
  lines.push(`- 导出时间（generatedAt）：${exported.generatedAt}`);
  lines.push(`- 候选账本：${total} 条；会话：${input.sessionCount} 个`);
  lines.push(`- SFT 指令对：${exported.sft.length} 条（空窗口：${countEmptyWindows(exported.sft)} 条）`);
  lines.push(`- DPO 偏好对：${exported.dpo.length} 条（漏报构造：--useful 人工标记 + 会中询问命中；空窗口：${countEmptyWindows(exported.dpo)} 条）`);
  lines.push("");
  lines.push("## 失败模式统计（7 终态）");
  lines.push("");
  lines.push("| 终态 | 样本量 | 占比 |");
  lines.push("|---|---:|---:|");
  for (const state of FINAL_STATES) {
    const count = exported.failureStats[state] ?? 0;
    const pct = total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "-";
    lines.push(`| ${state} | ${count} | ${pct} |`);
  }
  lines.push("");
  lines.push("## 会中询问信号（决策 65 第二通道）");
  lines.push("");
  lines.push("| 信号 | 样本量 |");
  lines.push("|---|---:|");
  lines.push(`| 漏报 DPO 对（model_skip 命中询问） | ${exported.askSignalStats.missedTriggerDpo} |`);
  lines.push(`| 卡片解释质量不足（card_shown 命中询问） | ${exported.askSignalStats.cardExplanationInsufficient} |`);
  lines.push("");
  lines.push("## Train/Eval 切分（按 session，防泄漏）");
  lines.push("");
  lines.push("- 规则：sha256(sessionId) 首字节 % 5 === 0 → eval（约 20%）；同一 session 的所有 pair 同 split。");
  let trainSessions = 0;
  let evalSessions = 0;
  for (const split of Object.values(exported.splitMap)) {
    if (split === "eval") evalSessions += 1;
    else trainSessions += 1;
  }
  const sftTrain = exported.sft.filter((pair) => pair.split === "train").length;
  const dpoTrain = exported.dpo.filter((pair) => pair.split === "train").length;
  lines.push(`- train：会话 ${trainSessions} 个，SFT ${sftTrain} 条，DPO ${dpoTrain} 条`);
  lines.push(`- eval：会话 ${evalSessions} 个，SFT ${exported.sft.length - sftTrain} 条，DPO ${exported.dpo.length - dpoTrain} 条`);
  lines.push("");
  lines.push("## 红线声明（决策 65）");
  lines.push("");
  lines.push("- 纯离线：本脚本仅「只读 SQLite → 本地导出文件」，不接任何实时链路；不自动改 Prompt、不动态改权重，模型替换由人工评估后决定。");
  lines.push("- 双通道漏报构造：DPO 来自 --useful 人工标记（人工把关）与会中询问命中（自动信号，决策 67 第二通道）；两条通道在 chosen 文案中分别标注来源。");
  lines.push("- 不含密钥与原始音频：导出字段白名单 = windowText/term/label/split/sessionId/candidateId/chosen/rejected 与统计数；sessions 只读 transcript_json，不读 cards_json / metrics_json；chat_messages 只读 role/content，不读任何 sources/密钥类字段；不触碰 settings / 密钥 / 音频文件。");
  lines.push("");
  return `${lines.join("\n")}`;
}

// --- CLI ---

interface CliOptions {
  dataDir: string;
  outDir: string;
  usefulFile: string | null;
  now: string;
}

function fail(message: string): never {
  process.stderr.write(`[export-training-data] ${message}\n`);
  process.exit(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printUsageAndFail(message: string): never {
  fail(
    `${message}\n用法：npx tsx scripts/export-training-data.ts [--data-dir <dir>] [--out <dir>] [--useful <json-file>] [--now <iso>]`,
  );
}

function parseCliOptions(argv: string[]): CliOptions {
  let dataDir = process.env.CUEMIND_DATA_DIR?.trim() || path.join(process.cwd(), ".data");
  let outDir: string | null = null;
  let usefulFile: string | null = null;
  let now = new Date().toISOString();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--data-dir" || flag === "--out" || flag === "--useful" || flag === "--now") {
      if (value === undefined || value.startsWith("--")) printUsageAndFail(`${flag} 需要一个参数值`);
      if (flag === "--data-dir") dataDir = value;
      else if (flag === "--out") outDir = value;
      else if (flag === "--useful") usefulFile = value;
      else {
        if (Number.isNaN(Date.parse(value))) printUsageAndFail(`--now 不是合法的 ISO 时间：${value}`);
        now = value;
      }
      index += 1;
    } else {
      printUsageAndFail(`未知参数：${flag}`);
    }
  }
  const resolvedDataDir = path.resolve(dataDir);
  return {
    dataDir: resolvedDataDir,
    outDir: path.resolve(outDir ?? path.join(resolvedDataDir, "training-export")),
    usefulFile,
    now,
  };
}

function readUsefulIds(file: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return fail(`无法读取 --useful 文件 ${file}：${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(`--useful 文件不是合法 JSON（应为 candidateId 的 string[]）：${file}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return fail(`--useful 文件内容必须是 string[]（candidateId 列表）：${file}`);
  }
  return new Set(parsed);
}

function readChatMessageRows(db: SqliteDatabase): ChatMessageRow[] {
  // chat_messages 为会中询问落库（决策 67）；旧库可能无该表 → 视为空（只读导出不得因缺表崩溃）。
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'")
    .get() as { name: string } | undefined;
  if (table === undefined) return [];
  return db
    .prepare("SELECT session_id AS sessionId, role, content FROM chat_messages")
    .all() as ChatMessageRow[];
}

function loadRows(dbPath: string): { candidates: CandidateRow[]; sessions: SessionRow[]; chatMessages: ChatMessageRow[] } {
  if (!existsSync(dbPath)) {
    fail(`未找到 ${dbPath}：请先运行 CueMind 产生会话数据。`);
  }
  let Database: SqliteDatabaseConstructor;
  try {
    // createRequire 与 lib/*-store 保持同一约定（原生模块加载失败 → 可解释错误）。
    const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
    Database = nodeRequire("better-sqlite3") as SqliteDatabaseConstructor;
  } catch (error) {
    return fail(`无法加载 better-sqlite3 原生模块：${messageOf(error)}`);
  }
  let db: SqliteDatabase;
  try {
    // 只读打开：绝不建文件、绝不写库（对齐 mcp-server/src/db.ts 约定）。
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return fail(`只读打开 ${dbPath} 失败：${messageOf(error)}`);
  }
  try {
    const candidates = db
      .prepare(
        "SELECT session_id AS sessionId, candidate_id AS candidateId, term, final_state AS finalState, created_at AS createdAt FROM candidates",
      )
      .all() as CandidateRow[];
    // 读取白名单：sessions 仅取 id + transcript_json（cards_json/metrics_json 不读）。
    const sessions = db
      .prepare("SELECT id, transcript_json AS transcriptJson FROM sessions")
      .all() as SessionRow[];
    // 会中询问历史：仅取 session_id / role / content。
    const chatMessages = readChatMessageRows(db);
    return { candidates, sessions, chatMessages };
  } catch (error) {
    return fail(`读取 candidates/sessions/chat_messages 表失败（${dbPath}）：${messageOf(error)}`);
  } finally {
    db.close();
  }
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const usefulIds = options.usefulFile !== null ? readUsefulIds(options.usefulFile) : new Set<string>();
  const { candidates, sessions, chatMessages } = loadRows(path.join(options.dataDir, SQLITE_DB_FILE));
  const exported = buildTrainingExport({ candidates, sessions, chatMessages, usefulIds, now: options.now });

  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(path.join(options.outDir, "sft.jsonl"), renderSftJsonl(exported));
  writeFileSync(path.join(options.outDir, "dpo.jsonl"), renderDpoJsonl(exported));
  writeFileSync(
    path.join(options.outDir, "report.md"),
    renderReport(exported, { candidateCount: candidates.length, sessionCount: sessions.length }),
  );
  writeFileSync(path.join(options.outDir, "split.json"), renderSplitJson(exported));

  const splitSessions = Object.values(exported.splitMap);
  const evalSessions = splitSessions.filter((split) => split === "eval").length;
  process.stdout.write(
    `[export-training-data] candidates=${candidates.length} sessions=${sessions.length} ` +
      `sft=${exported.sft.length} dpo=${exported.dpo.length} ` +
      `askMiss=${exported.askSignalStats.missedTriggerDpo} askCardInsuff=${exported.askSignalStats.cardExplanationInsufficient} ` +
      `split=${evalSessions}/${splitSessions.length} eval 会话 → ${options.outDir}（sft.jsonl, dpo.jsonl, report.md, split.json）\n`,
  );
}

// 作为入口直接运行时才执行 CLI；被测试 import 纯函数时不触发。
// 注意必须比对 basename：`test-export-training-data.ts` 也以本文件名结尾。
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  return path.basename(entry) === "export-training-data.ts";
}

if (isDirectRun()) {
  main();
}
