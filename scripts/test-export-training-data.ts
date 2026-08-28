import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildTrainingExport,
  FINAL_STATES,
  splitOf,
  type CandidateRow,
  type SessionRow,
} from "./export-training-data";

// export-training-data 回归（决策 65 轻量档，纯离线）：
// a) SFT：2 session × 多终态 → jsonl 行数 = term 非空数；instruction 含 term 与窗口文本；label = final_state
// b) 窗口重建：10 条 chunk，created_at 在 t8 后 → 取 ≤created_at 的最后 8 条；更晚的 created_at 验证截断
// c) DPO：model_skip + useful → 1；model_skip 非 useful → 0；card_shown + useful → 0；model_skip useful 但 term=null → 0
// d) 切分：同 session 所有 pair 同 split；splitMap 与 sha256 首字节 %5 规则一致（测试内重算）
// e) 幂等：纯函数固定 now 两次深等；CLI 两次（--now 固定、--out 两目录）文件字节一致
// f) failureStats 7 键齐全、计数正确（固定键序）
// g) db 缺失 → exit 1 + stderr 可解释
// h) 无密钥/音频：构造含 secret 的 cards_json/metrics_json → 导出不读、输出不含
// i) --useful 坏 JSON → exit 1 可解释

const FIXED_NOW = "2026-08-28T12:00:00.000Z";
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? "scripts/test-export-training-data.ts"));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CLI_PATH = path.join(SCRIPT_DIR, "export-training-data.ts");
const TMP_ROOT = mkdtempSync(path.join(tmpdir(), "cuemind-export-test-"));

interface SessionSeed {
  id: string;
  chunks: Array<Record<string, unknown>>;
  cardsJson?: string | null;
  metricsJson?: string | null;
}

interface CandidateSeed {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  createdAt: string;
  suppressReason?: string | null;
  cardId?: string | null;
}

// --- 造库（表结构照抄 lib/session-store.ts 与 lib/candidate-store.ts 的 CREATE 语句）---

function buildDb(dbDir: string, sessions: SessionSeed[], candidates: CandidateSeed[]): string {
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "cuemind.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER,
      input_source TEXT,
      transcript_json TEXT NOT NULL,
      cards_json TEXT,
      metrics_json TEXT
    );
    CREATE TABLE IF NOT EXISTS candidates (
      session_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      term TEXT,
      final_state TEXT NOT NULL,
      suppress_reason TEXT,
      card_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, candidate_id)
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, title, created_at, updated_at, duration_ms, input_source, transcript_json, cards_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertCandidate = db.prepare(
    "INSERT INTO candidates (session_id, candidate_id, term, final_state, suppress_reason, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const session of sessions) {
    insertSession.run(
      session.id,
      `标题-${session.id}`,
      "2026-08-28T09:00:00.000Z",
      "2026-08-28T13:00:00.000Z",
      null,
      "microphone",
      JSON.stringify(session.chunks),
      session.cardsJson ?? null,
      session.metricsJson ?? null,
    );
  }
  for (const candidate of candidates) {
    insertCandidate.run(
      candidate.sessionId,
      candidate.candidateId,
      candidate.term,
      candidate.finalState,
      candidate.suppressReason ?? null,
      candidate.cardId ?? null,
      candidate.createdAt,
    );
  }
  db.close();
  return dbPath;
}

function chunkAt(secondOffset: number, text: string): Record<string, unknown> {
  const timestamp = new Date(Date.UTC(2026, 7, 28, 10, 0, secondOffset)).toISOString();
  return {
    id: `c${secondOffset}`,
    text,
    timestamp,
    source: "microphone",
    startMs: secondOffset * 1000,
    endMs: secondOffset * 1000 + 900,
  };
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const loaderArgs = process.execArgv.length > 0 ? [...process.execArgv] : ["--import", "tsx"];
  const result = spawnSync(process.execPath, [...loaderArgs, CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function expectedSplit(sessionId: string): "train" | "eval" {
  return createHash("sha256").update(sessionId).digest()[0] % 5 === 0 ? "eval" : "train";
}

function readJsonlLines(file: string): Array<Record<string, unknown>> {
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return [];
  return raw.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

// --- 数据集 A：2+1 session × 9 candidate（7 终态全覆盖）---

const SECRET_CARDS_JSON = JSON.stringify([
  { api_key: "sk-test-SECRET_MARKER", whisperPath: "C:/secret/whisper.bin", data: "data:audio/wav;base64,QUJDREVG" },
]);
const SECRET_METRICS_JSON = JSON.stringify({ apiKey: "MK-SECRET-2", latencyP95: 1234 });

const DATASET_A_SESSIONS: SessionSeed[] = [
  {
    id: "s-alpha",
    chunks: [chunkAt(1, "Alpha 第一行"), chunkAt(2, "Alpha 第二行"), chunkAt(3, "Alpha 第三行")],
  },
  {
    id: "s-beta",
    chunks: [chunkAt(1, "Beta 第一行"), chunkAt(2, "Beta 第二行")],
  },
  {
    id: "s-secret",
    chunks: [chunkAt(1, "Secret 会话行")],
    cardsJson: SECRET_CARDS_JSON,
    metricsJson: SECRET_METRICS_JSON,
  },
];

const DATASET_A_CANDIDATES: CandidateSeed[] = [
  { sessionId: "s-alpha", candidateId: "ca1", term: "KV Cache", finalState: "card_shown", createdAt: "2026-08-28T10:00:05.000Z", cardId: "card-a1" },
  { sessionId: "s-alpha", candidateId: "ca2", term: null, finalState: "model_skip", createdAt: "2026-08-28T10:00:06.000Z" },
  { sessionId: "s-alpha", candidateId: "ca3", term: "推理优化", finalState: "search_failed", createdAt: "2026-08-28T10:00:07.000Z", suppressReason: "Tavily HTTP 401" },
  { sessionId: "s-beta", candidateId: "cb1", term: "LoRA", finalState: "model_skip", createdAt: "2026-08-28T11:00:05.000Z" },
  { sessionId: "s-beta", candidateId: "cb2", term: null, finalState: "invalid_schema", createdAt: "2026-08-28T11:00:06.000Z" },
  { sessionId: "s-beta", candidateId: "cb3", term: "RAG", finalState: "suppressed_as_duplicate", createdAt: "2026-08-28T11:00:07.000Z" },
  { sessionId: "s-beta", candidateId: "cb4", term: "MoE", finalState: "model_failed", createdAt: "2026-08-28T11:00:08.000Z" },
  { sessionId: "s-beta", candidateId: "cb5", term: null, finalState: "invalid_request", createdAt: "2026-08-28T11:00:09.000Z" },
  { sessionId: "s-secret", candidateId: "cs1", term: "SecretTerm", finalState: "card_shown", createdAt: "2026-08-28T12:00:05.000Z" },
];

const EXPECTED_LABELS: Record<string, string> = {
  ca1: "card_shown",
  ca3: "search_failed",
  cb1: "model_skip",
  cb3: "suppressed_as_duplicate",
  cb4: "model_failed",
  cs1: "card_shown",
};

function candidateRow(seed: CandidateSeed): CandidateRow {
  return {
    sessionId: seed.sessionId,
    candidateId: seed.candidateId,
    term: seed.term,
    finalState: seed.finalState,
    createdAt: seed.createdAt,
  };
}

function sessionRow(seed: SessionSeed): SessionRow {
  return { id: seed.id, transcriptJson: JSON.stringify(seed.chunks) };
}

// --- 用例 ---

function testCliExport(out1: string, out2: string, usefulFile: string): void {
  // a) SFT：行数 = term 非空数（6/9）；instruction 含 term 与窗口文本；label = final_state
  const sft = readJsonlLines(path.join(out1, "sft.jsonl"));
  assert.equal(sft.length, 6, "sft.jsonl 行数 = term 非空 candidate 数");
  for (const row of sft) {
    const candidateId = row.candidateId as string;
    assert.equal(typeof row.instruction, "string");
    assert.equal(row.output, EXPECTED_LABELS[candidateId], `label = final_state (${candidateId})`);
    assert.ok(
      row.split === "train" || row.split === "eval",
      `split ∈ {train, eval} (${candidateId})`,
    );
    assert.equal(row.split, expectedSplit(row.sessionId as string), "split 与 sha256 规则一致");
  }
  const ca1 = sft.find((row) => row.candidateId === "ca1");
  assert.ok(ca1);
  const ca1Instruction = ca1.instruction as string;
  assert.ok(ca1Instruction.includes("KV Cache"), "instruction 含 term");
  assert.ok(
    ca1Instruction.includes("判断以下会议窗口是否应提示关键词「KV Cache」。"),
    "instruction 使用固定模板",
  );
  assert.ok(ca1Instruction.includes("Alpha 第一行") && ca1Instruction.includes("Alpha 第三行"), "instruction 含窗口文本");
  assert.ok(ca1Instruction.includes("窗口文本："), "instruction 含窗口文本标签");

  // DPO：cb1（model_skip + useful）恰 1 条
  const dpo = readJsonlLines(path.join(out1, "dpo.jsonl"));
  assert.equal(dpo.length, 1, "dpo.jsonl 恰 1 条漏报构造");
  assert.equal(dpo[0].candidateId, "cb1");
  assert.equal(dpo[0].chosen, "应提示关键词「LoRA」（用户标记有用）");
  assert.equal(dpo[0].rejected, "不提示（model_skip）");
  assert.ok((dpo[0].prompt as string).includes("LoRA"), "dpo prompt 与 SFT instruction 同模板");
  assert.equal(dpo[0].split, expectedSplit("s-beta"));

  // split.json 与行内 split 一致
  const splitJson = JSON.parse(readFileSync(path.join(out1, "split.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(splitJson).sort(), ["s-alpha", "s-beta", "s-secret"]);
  for (const [sessionId, split] of Object.entries(splitJson)) {
    assert.equal(split, expectedSplit(sessionId), `split.json ${sessionId}`);
  }

  // h) 无密钥/音频：cards_json/metrics_json 中的标记不得出现在任何输出文件
  const positiveControl = new Database(path.join(TMP_ROOT, "dbA", "cuemind.db"), { readonly: true });
  const secretRow = positiveControl.prepare("SELECT cards_json, metrics_json FROM sessions WHERE id = 's-secret'").get() as {
    cards_json: string;
    metrics_json: string;
  };
  positiveControl.close();
  assert.ok(secretRow.cards_json.includes("sk-test-SECRET_MARKER"), "阳性对照：库内确有 secret");
  const allOutput = ["sft.jsonl", "dpo.jsonl", "report.md", "split.json"]
    .map((name) => readFileSync(path.join(out1, name), "utf8"))
    .join("\n");
  for (const marker of ["api_key", "apiKey", "whisperPath", "sk-test-SECRET_MARKER", "base64", "MK-SECRET-2", "data:audio"]) {
    assert.ok(!allOutput.includes(marker), `输出不得含 ${marker}`);
  }
  assert.ok(allOutput.includes("SecretTerm"), "term 白名单字段正常导出（对照非误杀）");

  // f) failureStats：7 键齐全、固定键序、计数正确（纯函数层断言 + report 落表）
  const exported = buildTrainingExport({
    candidates: DATASET_A_CANDIDATES.map(candidateRow),
    sessions: DATASET_A_SESSIONS.map(sessionRow),
    usefulIds: new Set(["cb1"]),
    now: FIXED_NOW,
  });
  assert.deepEqual(Object.keys(exported.failureStats), [...FINAL_STATES], "failureStats 固定 7 键序");
  assert.deepEqual(exported.failureStats, {
    card_shown: 2,
    model_skip: 2,
    suppressed_as_duplicate: 1,
    search_failed: 1,
    model_failed: 1,
    invalid_schema: 1,
    invalid_request: 1,
  });
  const report = readFileSync(path.join(out1, "report.md"), "utf8");
  assert.ok(report.includes("| card_shown | 2 |"), "report 含终态统计表");
  assert.ok(report.includes("红线"), "report 含红线声明");
  assert.ok(report.includes(FIXED_NOW), "report 含导出时间");

  // e) 幂等：CLI 第二次运行（同输入、同 --now、不同 --out）→ 4 文件字节一致
  for (const name of ["sft.jsonl", "dpo.jsonl", "report.md", "split.json"]) {
    const first = readFileSync(path.join(out1, name));
    const second = readFileSync(path.join(out2, name));
    assert.ok(first.equals(second), `${name} 两次运行字节一致`);
  }
  assert.ok(readFileSync(path.join(out2, "report.md"), "utf8").length > 0);
  console.log(`CLI export suite passed (useful=${usefulFile})`);
}

function testWindowRebuild(): void {
  // b) 10 条 chunk（t1..t10 = 10:00:00..10:00:09）
  const chunks = Array.from({ length: 10 }, (_, index) => chunkAt(index, `W-${String(index + 1).padStart(2, "0")}`));
  const sessions: SessionRow[] = [{ id: "sw", transcriptJson: JSON.stringify(chunks) }];
  const candidates: CandidateRow[] = [
    // created_at 在 t8(10:00:07) 之后、t9(10:00:08) 之前 → 过滤后恰为 t1..t8（8 条全取）
    { sessionId: "sw", candidateId: "cw1", term: "窗口词一", finalState: "card_shown", createdAt: "2026-08-28T10:00:07.500Z" },
    // created_at 在 t10 之后 → 过滤后 10 条，取最后 8 条 = t3..t10
    { sessionId: "sw", candidateId: "cw2", term: "窗口词二", finalState: "card_shown", createdAt: "2026-08-28T10:00:09.500Z" },
    // 无对应 session 行 → windowText = ""
    { sessionId: "sw-missing", candidateId: "cw3", term: "窗口词三", finalState: "card_shown", createdAt: "2026-08-28T10:00:07.500Z" },
  ];
  const exported = buildTrainingExport({ candidates, sessions, usefulIds: new Set(), now: FIXED_NOW });
  assert.equal(exported.sft.length, 3);
  const byId = new Map(exported.sft.map((pair) => [pair.candidateId, pair]));
  assert.equal(
    byId.get("cw1")!.windowText,
    Array.from({ length: 8 }, (_, index) => `W-${String(index + 1).padStart(2, "0")}`).join("\n"),
    "created_at 在 t8 后 → 窗口 = t1..t8（≤created_at 过滤）",
  );
  assert.equal(
    byId.get("cw2")!.windowText,
    Array.from({ length: 8 }, (_, index) => `W-${String(index + 3).padStart(2, "0")}`).join("\n"),
    "超过 8 条 → 取最后 8 条（t3..t10）",
  );
  assert.equal(byId.get("cw3")!.windowText, "", "无 session 行 → windowText 为空");
  console.log("window rebuild suite passed");
}

function testDpoConstruction(): void {
  // c) DPO 仅构造「model_skip + useful + term 非空」的漏报对
  const sessions: SessionRow[] = [{ id: "sd", transcriptJson: JSON.stringify([chunkAt(1, "DPO 窗口行")]) }];
  const candidates: CandidateRow[] = [
    { sessionId: "sd", candidateId: "d1", term: "漏报词", finalState: "model_skip", createdAt: "2026-08-28T10:00:05.000Z" },
    { sessionId: "sd", candidateId: "d2", term: "未标记词", finalState: "model_skip", createdAt: "2026-08-28T10:00:06.000Z" },
    { sessionId: "sd", candidateId: "d3", term: "已出卡词", finalState: "card_shown", createdAt: "2026-08-28T10:00:07.000Z" },
    { sessionId: "sd", candidateId: "d4", term: null, finalState: "model_skip", createdAt: "2026-08-28T10:00:08.000Z" },
  ];
  const exported = buildTrainingExport({
    candidates,
    sessions,
    usefulIds: new Set(["d1", "d3", "d4"]),
    now: FIXED_NOW,
  });
  assert.equal(exported.dpo.length, 1, "仅 d1（model_skip + useful + term 非空）构造 DPO");
  const pair = exported.dpo[0];
  assert.equal(pair.candidateId, "d1");
  assert.equal(pair.term, "漏报词");
  assert.equal(pair.chosen, "应提示关键词「漏报词」（用户标记有用）");
  assert.equal(pair.rejected, "不提示（model_skip）");
  assert.equal(pair.windowText, "DPO 窗口行", "DPO 与 SFT 同窗口文本");
  assert.equal(exported.sft.length, 3, "term 非空 3 条 → 3 条 SFT");
  console.log("DPO construction suite passed");
}

function testSplit(): void {
  // d) 同 session 所有 pair 同 split；splitMap 与 sha256 规则一致（测试内重算断言）
  function findSessionIdBySplit(want: "train" | "eval"): string {
    for (let index = 0; index < 10000; index += 1) {
      const id = `sess-probe-${index}`;
      if (expectedSplit(id) === want) return id;
    }
    throw new Error(`未找到 ${want} 型 sessionId`);
  }
  const evalId = findSessionIdBySplit("eval");
  const trainId = findSessionIdBySplit("train");
  assert.equal(splitOf(evalId), "eval", "splitOf 与 sha256 规则一致（eval）");
  assert.equal(splitOf(trainId), "train", "splitOf 与 sha256 规则一致（train）");

  const sessions: SessionRow[] = [
    { id: evalId, transcriptJson: JSON.stringify([chunkAt(1, "eval 行")]) },
    { id: trainId, transcriptJson: JSON.stringify([chunkAt(1, "train 行")]) },
  ];
  const candidates: CandidateRow[] = [
    { sessionId: evalId, candidateId: "e1", term: "词E1", finalState: "card_shown", createdAt: "2026-08-28T10:00:05.000Z" },
    { sessionId: evalId, candidateId: "e2", term: "词E2", finalState: "model_skip", createdAt: "2026-08-28T10:00:06.000Z" },
    { sessionId: trainId, candidateId: "t1", term: "词T1", finalState: "card_shown", createdAt: "2026-08-28T10:00:05.000Z" },
    { sessionId: trainId, candidateId: "t2", term: "词T2", finalState: "search_failed", createdAt: "2026-08-28T10:00:06.000Z" },
  ];
  const exported = buildTrainingExport({ candidates, sessions, usefulIds: new Set(["e2"]), now: FIXED_NOW });
  assert.equal(exported.splitMap[evalId], "eval");
  assert.equal(exported.splitMap[trainId], "train");
  for (const pair of [...exported.sft, ...exported.dpo]) {
    const expected = createHash("sha256").update(pair.sessionId).digest()[0] % 5 === 0 ? "eval" : "train";
    assert.equal(pair.split, expected, `pair ${pair.candidateId} split 与重算一致`);
    assert.equal(pair.split, exported.splitMap[pair.sessionId], "同 session 所有 pair 同 split（防泄漏）");
  }
  const evalPairs = exported.sft.filter((pair) => pair.sessionId === evalId);
  const trainPairs = exported.sft.filter((pair) => pair.sessionId === trainId);
  assert.equal(evalPairs.length, 2);
  assert.equal(trainPairs.length, 2);
  console.log(`split suite passed (eval=${evalId}, train=${trainId})`);
}

function testPureIdempotency(): void {
  // e) 纯函数幂等：同输入 + 固定 now 两次 → JSON.stringify 深等
  const args = {
    candidates: DATASET_A_CANDIDATES.map(candidateRow),
    sessions: DATASET_A_SESSIONS.map(sessionRow),
    usefulIds: new Set(["cb1"]),
    now: FIXED_NOW,
  };
  const first = JSON.stringify(buildTrainingExport(args));
  const second = JSON.stringify(buildTrainingExport(args));
  assert.equal(first, second, "同输入 + 同 now → 输出深等");
  console.log("pure idempotency suite passed");
}

function testCliErrorPaths(): void {
  // g) db 缺失：--data-dir 空目录 → exit 1 + stderr 可解释
  const emptyDir = path.join(TMP_ROOT, "empty-data");
  mkdirSync(emptyDir, { recursive: true });
  const missing = runCli(["--data-dir", emptyDir, "--out", path.join(TMP_ROOT, "out-missing")]);
  assert.equal(missing.status, 1, "db 缺失 → exit 1");
  assert.ok(missing.stderr.includes("cuemind.db"), "stderr 指明缺失文件");
  assert.ok(missing.stderr.includes("产生会话数据"), "stderr 含可解释指引");

  // i) --useful 坏 JSON → exit 1 可解释
  const badUseful = path.join(TMP_ROOT, "useful-bad.json");
  writeFileSync(badUseful, "{这不是 JSON");
  const badUsefulResult = runCli([
    "--data-dir",
    path.join(TMP_ROOT, "dbA"),
    "--out",
    path.join(TMP_ROOT, "out-bad-useful"),
    "--useful",
    badUseful,
  ]);
  assert.equal(badUsefulResult.status, 1, "--useful 坏 JSON → exit 1");
  assert.ok(badUsefulResult.stderr.includes("JSON"), "stderr 说明 JSON 解析失败");
  console.log("CLI error paths suite passed");
}

function main(): void {
  const dbADir = path.join(TMP_ROOT, "dbA");
  buildDb(dbADir, DATASET_A_SESSIONS, DATASET_A_CANDIDATES);
  const usefulFile = path.join(TMP_ROOT, "useful.json");
  writeFileSync(usefulFile, JSON.stringify(["cb1"]));

  const out1 = path.join(TMP_ROOT, "out1");
  const out2 = path.join(TMP_ROOT, "out2");
  const first = runCli(["--data-dir", dbADir, "--out", out1, "--useful", usefulFile, "--now", FIXED_NOW]);
  assert.equal(first.status, 0, `CLI 首次运行应成功：${first.stderr}`);
  const second = runCli(["--data-dir", dbADir, "--out", out2, "--useful", usefulFile, "--now", FIXED_NOW]);
  assert.equal(second.status, 0, `CLI 二次运行应成功：${second.stderr}`);
  testCliExport(out1, out2, usefulFile);

  testWindowRebuild();
  testDpoConstruction();
  testSplit();
  testPureIdempotency();
  testCliErrorPaths();

  console.log("export-training-data regression tests passed");
}

main();
