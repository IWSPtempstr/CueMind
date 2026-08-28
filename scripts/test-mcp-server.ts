import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

// mcp-server（M1-b + M2-b，本地只读 stdio MCP）spawn 自测。
// 不依赖 MCP SDK 客户端：child_process.spawn 直接起 node mcp-server/dist/index.js，
// 按 MCP stdio 约定（换行分隔 JSON-RPC，stdout 上不得出现任何非 JSON-RPC 内容）收发。
// 断言：
//   a) initialize 返回 serverInfo
//   b) tools/list 含 M1 三工具
//   c) list_sessions 返回元数据数组（无 transcriptJson/cardsJson/metricsJson 载荷）
//   d) get_session offset/limit 分页正确（total/hasMore），不存在 id → 可解释错误终态，
//      chunk 白名单剥离 latency（trace payload）
//   e) search_transcripts 中文 query 命中（2-gram），含 matchedExcerpt
//   h) tools/list 含 6 个工具（新增 search_cards / get_card / get_session_ledger）
//   i) get_session_ledger：m2-smoke 会话的 card_shown 账本行 + finalStateSummary 自洽
//   j) search_cards：term 子串命中（大小写不敏感）+ sessionTitle（LEFT JOIN 语义）；
//      keyword 二次匹配与空白/无命中路径
//   k) get_card：账本部分完整；卡片正文按实际归档状态断言（未归档 → note 存在且不谎报）；
//      不存在的 card_id → error 终态
//   l) 只读断言（M1 f 模式扩展）：文件清单一致、cuemind.db 主文件 size+mtime 不变，
//      sessions 与 candidates 行数均不变
//   m) 空结果路径：ledger 查不存在 session → 空数组 + total 0（非错误终态）
//   g) db 缺失路径：CUEMIND_DATA_DIR=/tmp/nonexistent-mcp → 工具返回可解释 error 终态且 server 不崩
// M3-b（vault 合流，只读）：
//   n) 种子 vault：/tmp/m3-vault-mcp/cuemind/concepts 写 2 个合法概念（frontmatter+正文+变更小节）
//      + 1 个坏 frontmatter 文件（应跳过不崩）
//   o) search_cards 合流：SQLite 命中（origin:"sqlite"）与 vault 概念命中（origin:"vault"，
//      aliases/updated/relativePath/originMeetings 透出）并存
//   p) get_card：账本 term 与 vault 概念一致且正文未归档 → card 来自 vault（origin/updated/
//      relativePath/aliases/keyPoints/sources）+ note "card body from vault concepts"
//   q) CUEMIND_VAULT_DIR 指向不存在目录 → search_cards 仅 SQLite 结果不报错（静默跳过），
//      get_card 维持既有诚实降级
//   r) 只读断言：vault 目录文件内容+size+mtime 前后不变
//   s) 坏 frontmatter 文件被跳过，其余概念仍可检索
// a-m 不回退：CUEMIND_VAULT_DIR 未设（测试客户端显式 unset）→ 默认路径 <dataDir>/vault
// 不存在即静默跳过，行为与 M2-b 完全一致。
// 账本种子策略：优先用真实 .data（m2-smoke 的 card_shown 行已由主项目真机写入）；若缺失，
// 复制 .data 到临时目录并灌 sessions+candidates 种子（绝不写开发 .data）。
// 前置：cd CueMind && (cd mcp-server && npm install && npm run build)；dev server :3000 在跑且
// .data 已有种子数据（mcp-seed-a=7 chunks / mcp-seed-b=5 chunks，见仓库 README 或灌数脚本）。

const PROJECT_ROOT = process.cwd();
const MCP_SERVER_ENTRY = path.join(PROJECT_ROOT, "mcp-server", "dist", "index.js");
const DATA_DIR = path.resolve(".data");
const DB_FILE = path.join(DATA_DIR, "cuemind.db");
const REQUEST_TIMEOUT_MS = 20_000;

const SEED_A = "mcp-seed-a";
const SEED_B = "mcp-seed-b";
const SEED_M2 = "m2-smoke";

// 隔离灌种时的确定种子（只写临时目录副本；卡片正文归档进 sessions.cards_json 以覆盖
// get_card 的归档命中路径与 search_cards 的 keyword 二次匹配路径）。
const SEED_CANDIDATE_ID = "seed-candidate-spec-decode";
const SEED_CARD_ID = "seed-card-spec-decode";
const SEED_CANDIDATE_2_ID = "seed-candidate-ring-attention";
const SEED_CARD_2_ID = "seed-card-ring-attention";
const SEED_CREATED_AT = "2026-08-28T06:14:07.139Z";
const SEED_M2_TITLE = "M2 冒烟：speculative decoding 讨论卡";

// M3-b vault 合流夹具：独立 SQLite（term 与 vault 概念一致、正文未归档）+ 固定路径 vault 目录。
const VAULT_DIR = path.join(tmpdir(), "m3-vault-mcp");
const VAULT_FIXTURE_SESSION = "m3-vault-smoke";
const VAULT_FIXTURE_CANDIDATE_ID = "seed-candidate-ring-attention-vault";
const VAULT_FIXTURE_CARD_ID = "seed-card-ring-attention-vault";
const VAULT_FIXTURE_TERM = "Ring Attention";
const VAULT_FIXTURE_UPDATED = "2026-08-28T01:02:03.000Z";
const VAULT_FIXTURE_ALIAS_CN = "环形注意力";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface ListSessionsPayload {
  sessions: Array<Record<string, unknown>>;
}

interface GetSessionPayload {
  session: Record<string, unknown>;
  chunks: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface SearchPayload {
  results: Array<{ sessionId: string; title: string; updatedAt: string; matchedExcerpt: string }>;
}

interface SearchCardsPayload {
  query: string;
  // M3-b 合流后的结果联合：SQLite 行（origin:"sqlite"，原字段齐全）与 vault 概念命中
  // （origin:"vault"，term/aliases/updated/relativePath/originMeetings）。字段按 origin 取用。
  results: Array<{
    origin?: "sqlite" | "vault";
    candidateId?: string;
    sessionId?: string;
    sessionTitle?: string | null;
    term?: string | null;
    finalState?: string;
    cardId?: string | null;
    createdAt?: string;
    source?: "vault";
    aliases?: string[];
    updated?: string | null;
    relativePath?: string;
    originMeetings?: string[];
  }>;
}

interface GetCardPayload {
  ledger: {
    sessionId: string;
    sessionTitle: string | null;
    candidateId: string;
    term: string | null;
    finalState: string;
    suppressReason: string | null;
    cardId: string | null;
    createdAt: string;
  };
  card: Record<string, unknown> | null;
  note?: string;
}

interface GetSessionLedgerPayload {
  sessionId: string;
  candidates: Array<{
    candidateId: string;
    term: string | null;
    finalState: string;
    suppressReason: string | null;
    cardId: string | null;
    createdAt: string;
  }>;
  total: number;
  finalStateSummary: Record<string, number>;
}

/** 账本夹具：优先真实 .data 的 card_shown 行；不可用时降级为临时目录灌种。 */
interface CandidateFixture {
  dataDir: string;
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  cardId: string;
  createdAt: string;
  /** true = 用的是临时目录灌种（此时卡片正文归档可断言）。 */
  seeded: boolean;
}

/** 极简 MCP stdio 客户端：换行分隔 JSON-RPC，按 id 匹配响应。 */
class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  constructor(
    private readonly dataDir: string,
    // M3-b：vaultDir 语义——undefined 继承外层 env；null 显式 unset（默认路径 <dataDir>/vault）；
    // 字符串显式指向测试 vault 目录。
    private readonly vaultDir?: string | null,
  ) {}

  start(): void {
    const env: NodeJS.ProcessEnv = { ...process.env, CUEMIND_DATA_DIR: this.dataDir };
    if (this.vaultDir === null) delete env.CUEMIND_VAULT_DIR;
    else if (typeof this.vaultDir === "string") env.CUEMIND_VAULT_DIR = this.vaultDir;
    this.child = spawn(process.execPath, [MCP_SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.length > 0) this.handleLine(line);
        newlineIndex = this.buffer.indexOf("\n");
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[mcp stderr] ${chunk}`);
    });
  }

  private handleLine(line: string): void {
    // stdout 纯净性的隐式断言：任何非 JSON-RPC 行都会在此抛错使测试失败。
    const message = JSON.parse(line) as JsonRpcResponse;
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      entry.reject(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
    } else {
      entry.resolve(message.result);
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    assert.notEqual(child, null, "client not started");
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method} (id=${id})`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child!.stdin.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    assert.notEqual(this.child, null, "client not started");
    this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }
}

function parseToolText(result: unknown): ToolCallResult {
  const call = result as ToolCallResult;
  assert.ok(Array.isArray(call.content) && call.content.length > 0, "tool result has content");
  assert.equal(call.content[0].type, "text");
  return call;
}

function toolPayload<T>(result: unknown): T {
  return JSON.parse(parseToolText(result).content[0].text) as T;
}

function snapshotDataDir(dataDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const name of readdirSync(dataDir).sort()) {
    const stats = statSync(path.join(dataDir, name));
    snapshot.set(name, `${stats.size}/${stats.mtimeMs}`);
  }
  return snapshot;
}

type SqliteDatabase = {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  pragma: (source: string) => unknown;
  close: () => void;
};

type SqliteDatabaseConstructor = new (
  file: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => SqliteDatabase;

function requireSqlite(): SqliteDatabaseConstructor {
  const requireFromProject = createRequire(path.join(PROJECT_ROOT, "package.json"));
  return requireFromProject("better-sqlite3") as SqliteDatabaseConstructor;
}

function tableRowCount(dataDir: string, table: string): number {
  const Database = requireSqlite();
  const db = new Database(path.join(dataDir, "cuemind.db"), { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// 隔离灌种的归档卡片（ContextCard 形状，含 trace/调试字段以验证白名单投影剥离）。
const ARCHIVED_SEED_CARDS = [
  {
    id: SEED_CARD_ID,
    candidateId: SEED_CANDIDATE_ID,
    datasetVersion: "demo-v1",
    windowingVersion: "window-v1",
    coreStartMs: 12000,
    coreEndMs: 18000,
    contextStartMs: 9000,
    contextEndMs: 21000,
    keyword: "speculative decoding",
    keyPoints: [
      "Draft model proposes tokens; target model verifies them in parallel.",
      "Acceptance rate drives the end-to-end speedup.",
    ],
    whyNow: "讨论推理延迟优化时该术语首次出现。",
    sources: [
      {
        title: "Speculative Decoding (arXiv)",
        url: "https://arxiv.org/abs/2211.17192",
        snippet: "Fast inference from transformers via speculative decoding.",
        sourceType: "arxiv",
      },
      {
        title: "Hacker News discussion",
        url: "https://news.ycombinator.com/item?id=1",
        snippet: "Community thread on speculative decoding speedups.",
        sourceType: "hackernews",
      },
    ],
    createdAt: "2026-08-28T06:14:07.000Z",
    transcriptChunkIds: ["a1"],
    latencyMs: { keyword: 10, search: 20, generation: 30, total: 60 },
  },
  {
    id: SEED_CARD_2_ID,
    candidateId: SEED_CANDIDATE_2_ID,
    datasetVersion: "demo-v1",
    windowingVersion: "window-v1",
    coreStartMs: 30000,
    coreEndMs: 35000,
    contextStartMs: 28000,
    contextEndMs: 37000,
    keyword: "Ring Attention",
    whyNow: "讨论长上下文内存优化时提到。",
    sources: [
      {
        title: "Ring Attention (arXiv)",
        url: "https://arxiv.org/abs/2310.01889",
        snippet: "Blockwise computation of attention over long sequences.",
        sourceType: "arxiv",
      },
      {
        title: "Reference implementation",
        url: "https://github.com/example/ring-attention",
        snippet: "Community implementation.",
        sourceType: "github",
      },
    ],
    createdAt: "2026-08-28T06:14:07.050Z",
    transcriptChunkIds: [],
    latencyMs: { keyword: 5, search: 15, generation: 25, total: 45 },
  },
];

/**
 * 账本夹具（h-m 的数据保障）：
 * 1) 真实 .data 已有 card_shown 且带 card_id 的行 → 直接用（任务书：优先真实数据）；
 * 2) 否则复制 .data 到临时目录（保证 a-g 所需会话种子仍在）并灌 sessions+candidates
 *    种子——只写临时目录，绝不写开发 .data。副本转 DELETE journal 模式，避免 readonly
 *    打开 WAL 数据库时对 -shm/-wal 的创建依赖。
 */
function prepareCandidateFixture(): CandidateFixture {
  // CUEMIND_MCP_TEST_FORCE_SEED=1：强制走灌种路径（验证降级分支与卡片归档断言本身）。
  const forceSeed = process.env.CUEMIND_MCP_TEST_FORCE_SEED === "1";
  if (existsSync(DB_FILE) && !forceSeed) {
    try {
      const Database = requireSqlite();
      const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
      let row:
        | { session_id: string; candidate_id: string; term: string | null; final_state: string; card_id: string; created_at: string }
        | undefined;
      try {
        row = db
          .prepare(
            "SELECT session_id, candidate_id, term, final_state, card_id, created_at FROM candidates WHERE final_state = 'card_shown' AND card_id IS NOT NULL AND card_id != '' ORDER BY created_at DESC LIMIT 1",
          )
          .get() as typeof row;
      } finally {
        db.close();
      }
      if (row !== undefined) {
        return {
          dataDir: DATA_DIR,
          sessionId: row.session_id,
          candidateId: row.candidate_id,
          term: row.term,
          finalState: row.final_state,
          cardId: row.card_id,
          createdAt: row.created_at,
          seeded: false,
        };
      }
    } catch {
      // .data 打不开/损坏 → 走灌种路径。
    }
  }
  const seededDir = mkdtempSync(path.join(tmpdir(), "cuemind-mcp-candidates-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${DB_FILE}${suffix}`;
    if (existsSync(source)) copyFileSync(source, path.join(seededDir, `cuemind.db${suffix}`));
  }
  const Database = requireSqlite();
  const seededDbFile = path.join(seededDir, "cuemind.db");
  const db = new Database(seededDbFile, { fileMustExist: existsSync(seededDbFile) });
  try {
    // 与主项目 lib/session-store.ts / lib/candidate-store.ts 的 DDL 同款（测试灌种专用）。
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
    db.pragma("journal_mode = DELETE");
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at, duration_ms, input_source, transcript_json, cards_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(SEED_M2, SEED_M2_TITLE, SEED_CREATED_AT, SEED_CREATED_AT, 30000, "mixed", "[]", JSON.stringify(ARCHIVED_SEED_CARDS), null);
    const insertCandidate = db.prepare(
      "INSERT OR REPLACE INTO candidates (session_id, candidate_id, term, final_state, suppress_reason, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertCandidate.run(SEED_M2, SEED_CANDIDATE_ID, "speculative decoding", "card_shown", null, SEED_CARD_ID, SEED_CREATED_AT);
    // term 为 NULL 的第二候选：只能被归档卡片 keyword 二次匹配命中（覆盖 search_cards 合并路径）。
    insertCandidate.run(SEED_M2, SEED_CANDIDATE_2_ID, null, "card_shown", null, SEED_CARD_2_ID, "2026-08-28T06:14:07.500Z");
  } finally {
    db.close();
  }
  return {
    dataDir: seededDir,
    sessionId: SEED_M2,
    candidateId: SEED_CANDIDATE_ID,
    term: "speculative decoding",
    finalState: "card_shown",
    cardId: SEED_CARD_ID,
    createdAt: SEED_CREATED_AT,
    seeded: true,
  };
}

function printSnapshotDiff(before: Map<string, string>, after: Map<string, string>): void {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  console.log("  file | before(size/mtime) | after(size/mtime) | verdict");
  for (const name of names) {
    const left = before.get(name);
    const right = after.get(name);
    if (left === undefined) console.log(`  ${name} | - | ${right} | ADDED (must fail)`);
    else if (right === undefined) console.log(`  ${name} | ${left} | - | REMOVED (must fail)`);
    else if (left === right) console.log(`  ${name} | ${left} | ${right} | unchanged`);
    else console.log(`  ${name} | ${left} | ${right} | mtime-changed (allowed for -shm/-wal only)`);
  }
}

function assertReadOnly(
  before: Map<string, string>,
  dataDir: string,
  sessionsBefore: number,
  candidatesBefore: number,
): void {
  const after = snapshotDataDir(dataDir);
  const sessionsAfter = tableRowCount(dataDir, "sessions");
  const candidatesAfter = tableRowCount(dataDir, "candidates");
  printSnapshotDiff(before, after);
  assert.deepEqual(
    [...after.keys()],
    [...before.keys()],
    "只读断言失败：.data 出现新增/删除文件（例如 -journal）",
  );
  assert.equal(
    after.get("cuemind.db"),
    before.get("cuemind.db"),
    "只读断言失败：cuemind.db 主文件 size/mtime 发生变化",
  );
  assert.equal(sessionsAfter, sessionsBefore, "只读断言失败：sessions 行数变化");
  assert.equal(candidatesAfter, candidatesBefore, "只读断言失败：candidates 行数变化");
  console.log(
    `  sessions 行数: before=${sessionsBefore} after=${sessionsAfter}（一致）；candidates 行数: before=${candidatesBefore} after=${candidatesAfter}（一致）`,
  );
}

function assertSessionSummary(item: Record<string, unknown>): void {
  for (const key of ["id", "title", "createdAt", "updatedAt", "durationMs", "inputSource", "transcriptChars"]) {
    assert.ok(key in item, `summary missing field: ${key}`);
  }
  for (const forbidden of ["transcriptJson", "cardsJson", "metricsJson"]) {
    assert.ok(!(forbidden in item), `summary must not expose ${forbidden}`);
  }
}

async function assertNormalServer(fixture: CandidateFixture): Promise<void> {
  const beforeSnapshot = snapshotDataDir(fixture.dataDir);
  const sessionsBefore = tableRowCount(fixture.dataDir, "sessions");
  const candidatesBefore = tableRowCount(fixture.dataDir, "candidates");
  // 显式 unset CUEMIND_VAULT_DIR：a-m 行为与 M2-b 完全一致（默认路径 <dataDir>/vault
  // 不存在 → 静默跳过），不随外层环境漂移。
  const client = new McpStdioClient(fixture.dataDir, null);
  client.start();

  // a) initialize → serverInfo
  const initialized = (await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cuemind-mcp-smoke", version: "0.0.1" },
  })) as { protocolVersion: string; serverInfo: { name: string; version: string } };
  assert.equal(initialized.serverInfo.name, "cuemind");
  assert.ok(initialized.serverInfo.version.length > 0, "serverInfo.version present");
  assert.ok(initialized.protocolVersion.length > 0, "negotiated protocolVersion present");
  console.log(`[a] initialize OK: serverInfo=${JSON.stringify(initialized.serverInfo)}, protocol=${initialized.protocolVersion}`);
  client.notify("notifications/initialized");

  // b) tools/list
  const toolList = (await client.request("tools/list", {})) as { tools: Array<{ name: string }> };
  const toolNames = new Set(toolList.tools.map((tool) => tool.name));
  for (const expected of ["list_sessions", "get_session", "search_transcripts"]) {
    assert.ok(toolNames.has(expected), `tools/list missing ${expected}`);
  }
  console.log(`[b] tools/list OK: ${[...toolNames].sort().join(", ")}`);

  // c) list_sessions
  const listedResult = parseToolText(
    await client.request("tools/call", { name: "list_sessions", arguments: {} }),
  );
  assert.ok(!listedResult.isError, "list_sessions must not be an error terminal");
  const listed = toolPayload<ListSessionsPayload>(
    await client.request("tools/call", { name: "list_sessions", arguments: {} }),
  );
  assert.ok(listed.sessions.length >= 4, `expected >=4 sessions, got ${listed.sessions.length}`);
  const listedIds = new Set(listed.sessions.map((item) => String(item.id)));
  assert.ok(listedIds.has(SEED_A) && listedIds.has(SEED_B), "both seeds listed");
  for (const item of listed.sessions) assertSessionSummary(item);
  const updatedAts = listed.sessions.map((item) => String(item.updatedAt));
  assert.deepEqual(
    updatedAts,
    [...updatedAts].sort().reverse(),
    "list_sessions must be ordered by updatedAt desc",
  );
  const limited = toolPayload<ListSessionsPayload>(
    await client.request("tools/call", { name: "list_sessions", arguments: { limit: 1 } }),
  );
  assert.equal(limited.sessions.length, 1, "limit=1 returns exactly 1");
  const filtered = toolPayload<ListSessionsPayload>(
    await client.request("tools/call", {
      name: "list_sessions",
      arguments: { from: "2030-01-01T00:00:00.000Z" },
    }),
  );
  assert.equal(filtered.sessions.length, 0, "future from filters everything out");
  console.log(`[c] list_sessions OK: ${listed.sessions.length} 条（含双种子）、字段齐全、无转写载荷、DESC/limit/from 过滤正确`);

  // d) get_session 分页
  const page1 = toolPayload<GetSessionPayload>(
    await client.request("tools/call", {
      name: "get_session",
      arguments: { session_id: SEED_B, offset: 0, limit: 3 },
    }),
  );
  assert.equal(page1.total, 5);
  assert.equal(page1.chunks.length, 3);
  assert.equal(page1.offset, 0);
  assert.equal(page1.limit, 3);
  assert.equal(page1.hasMore, true);
  const page2 = toolPayload<GetSessionPayload>(
    await client.request("tools/call", {
      name: "get_session",
      arguments: { session_id: SEED_B, offset: 3, limit: 3 },
    }),
  );
  assert.equal(page2.total, 5);
  assert.equal(page2.chunks.length, 2);
  assert.equal(page2.hasMore, false);
  const firstOfA = toolPayload<GetSessionPayload>(
    await client.request("tools/call", {
      name: "get_session",
      arguments: { session_id: SEED_A, offset: 0, limit: 1 },
    }),
  );
  assert.equal(String(firstOfA.chunks[0].id), "a1");
  assert.ok(!("latency" in firstOfA.chunks[0]), "trace payload (latency) must be stripped");
  const missing = parseToolText(
    await client.request("tools/call", { name: "get_session", arguments: { session_id: "no-such-session" } }),
  );
  assert.equal(missing.isError, true, "missing session must be an error terminal");
  const missingPayload = JSON.parse(missing.content[0].text) as { error: string };
  assert.ok(missingPayload.error.includes("Session not found"), "explainable not-found error");
  console.log(`[d] get_session OK: total=5 分页 3+2、hasMore 正确、latency 被剥离、缺失 id → error 终态`);

  // e) search_transcripts 中文命中
  const chinese = toolPayload<SearchPayload>(
    await client.request("tools/call", { name: "search_transcripts", arguments: { query: "知识沉淀" } }),
  );
  const seedBHit = chinese.results.find((hit) => hit.sessionId === SEED_B);
  assert.ok(seedBHit !== undefined, "Chinese query must hit mcp-seed-b");
  assert.ok(seedBHit.matchedExcerpt.includes("知识"), "excerpt centers on the matched term");
  const titleHit = toolPayload<SearchPayload>(
    await client.request("tools/call", { name: "search_transcripts", arguments: { query: "指标评审" } }),
  );
  assert.ok(
    titleHit.results.some((hit) => hit.sessionId === SEED_A),
    "query matching title column must hit mcp-seed-a",
  );
  const punctuation = toolPayload<SearchPayload>(
    await client.request("tools/call", { name: "search_transcripts", arguments: { query: "。！？" } }),
  );
  assert.equal(punctuation.results.length, 0, "punctuation-only query yields no hits");
  console.log(`[e] search_transcripts OK: “知识沉淀”命中 ${SEED_B}，excerpt=“${seedBHit.matchedExcerpt.slice(0, 24)}…”，标题命中与空结果正确`);

  // h) tools/list 现在共 6 个工具（M1 三工具 + M2-b 三工具）
  const fullToolList = (await client.request("tools/list", {})) as { tools: Array<{ name: string }> };
  const fullToolNames = fullToolList.tools.map((tool) => tool.name).sort();
  assert.deepEqual(fullToolNames, [
    "get_card",
    "get_session",
    "get_session_ledger",
    "list_sessions",
    "search_cards",
    "search_transcripts",
  ]);
  console.log(`[h] tools/list OK: 共 ${fullToolNames.length} 个工具（含新增 search_cards/get_card/get_session_ledger）`);

  // i) get_session_ledger：card_shown 账本行 + finalStateSummary 自洽
  const ledger = toolPayload<GetSessionLedgerPayload>(
    await client.request("tools/call", {
      name: "get_session_ledger",
      arguments: { session_id: fixture.sessionId },
    }),
  );
  assert.equal(ledger.sessionId, fixture.sessionId);
  assert.equal(ledger.total, ledger.candidates.length, "total matches candidates length");
  assert.ok(ledger.total >= 1, `expected >=1 ledger rows, got ${ledger.total}`);
  const ledgerHit = ledger.candidates.find((entry) => entry.candidateId === fixture.candidateId);
  assert.ok(ledgerHit !== undefined, "fixture candidate must be in the ledger");
  assert.equal(ledgerHit.term, fixture.term);
  assert.equal(ledgerHit.finalState, fixture.finalState);
  assert.equal(ledgerHit.cardId, fixture.cardId);
  assert.equal(ledgerHit.createdAt, fixture.createdAt);
  assert.ok((ledger.finalStateSummary[fixture.finalState] ?? 0) >= 1, "finalStateSummary counts card_shown");
  const summarized = Object.values(ledger.finalStateSummary).reduce((left, right) => left + right, 0);
  assert.equal(summarized, ledger.total, "finalStateSummary sums up to total");
  if (fixture.seeded) {
    // 副本可能还带着 .data 原有行，只断言两个种子候选必然在账本中。
    assert.ok(ledger.total >= 2, `seeded m2-smoke must have >=2 candidates, got ${ledger.total}`);
    assert.ok(
      ledger.candidates.some((entry) => entry.candidateId === SEED_CANDIDATE_2_ID),
      "second seeded candidate must be in the ledger",
    );
  }
  console.log(
    `[i] get_session_ledger OK: session=${fixture.sessionId} total=${ledger.total} summary=${JSON.stringify(ledger.finalStateSummary)}`,
  );

  // j) search_cards：term 子串命中（大小写不敏感）+ 合并路径
  const cardSearch = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "Speculative" } }),
  );
  const cardHit = cardSearch.results.find((hit) => hit.candidateId === fixture.candidateId);
  assert.ok(cardHit !== undefined, "search_cards must hit the card_shown candidate");
  assert.equal(cardHit.sessionId, fixture.sessionId);
  assert.equal(cardHit.term, fixture.term);
  assert.equal(cardHit.finalState, "card_shown");
  assert.equal(cardHit.cardId, fixture.cardId);
  assert.equal(cardHit.createdAt, fixture.createdAt);
  if (fixture.seeded) {
    assert.equal(cardHit.sessionTitle, SEED_M2_TITLE, "session title joined from sessions table");
    // keyword 二次匹配：该候选 term 为 NULL，只有归档卡片 keyword 命中这一条路能找到它。
    const keywordOnly = toolPayload<SearchCardsPayload>(
      await client.request("tools/call", { name: "search_cards", arguments: { query: "ring attention" } }),
    );
    assert.ok(
      keywordOnly.results.some((hit) => hit.candidateId === SEED_CANDIDATE_2_ID),
      "archived card keyword match must surface a term-NULL candidate",
    );
  } else {
    // 真实数据现实：m2-smoke 的会话快照未落库 → sessionTitle 为 null（LEFT JOIN 不丢行）。
    assert.equal(cardHit.sessionTitle, null, "ledger rows without a session row expose null title");
  }
  const cardNoHit = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "zzz-no-such-term-xyz" } }),
  );
  assert.equal(cardNoHit.results.length, 0, "unknown term yields []");
  const cardWhitespace = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "   " } }),
  );
  assert.equal(cardWhitespace.results.length, 0, "whitespace-only query yields []");
  console.log(
    `[j] search_cards OK: query="Speculative" 命中 ${String(cardHit.candidateId).slice(0, 13)}…（finalState=card_shown），空结果与空白 query 路径正确`,
  );

  // k) get_card：账本完整；卡片正文按实际归档状态断言（不谎报）
  const cardResult = parseToolText(
    await client.request("tools/call", { name: "get_card", arguments: { card_id: fixture.cardId } }),
  );
  assert.ok(!cardResult.isError, "existing card_id must not be an error terminal");
  const cardPayload = JSON.parse(cardResult.content[0].text) as GetCardPayload;
  assert.equal(cardPayload.ledger.candidateId, fixture.candidateId);
  assert.equal(cardPayload.ledger.sessionId, fixture.sessionId);
  assert.equal(cardPayload.ledger.term, fixture.term);
  assert.equal(cardPayload.ledger.finalState, "card_shown");
  assert.equal(cardPayload.ledger.cardId, fixture.cardId);
  assert.equal(cardPayload.ledger.createdAt, fixture.createdAt);
  if (fixture.seeded) {
    assert.ok(cardPayload.card !== null, "seeded session archives the card body");
    assert.equal(cardPayload.card.keyword, "speculative decoding");
    assert.ok(Array.isArray(cardPayload.card.sources) && cardPayload.card.sources.length === 2);
    const evidence = cardPayload.card.evidenceWindow as Record<string, number> | undefined;
    assert.equal(evidence?.coreStartMs, 12000);
    assert.equal(evidence?.contextEndMs, 21000);
    for (const forbidden of ["demoTrace", "datasetVersion", "windowingVersion", "transcriptChunkIds", "candidateId"]) {
      assert.ok(!(forbidden in cardPayload.card), `card projection must strip ${forbidden}`);
    }
    assert.ok(cardPayload.note === undefined, "no note when the card body is archived");
  } else {
    // 当前真实数据：sessions.cards_json 恒为 null → 卡片正文未归档，诚实降级。
    assert.equal(cardPayload.card, null, "card body not archived in current snapshots");
    assert.ok(typeof cardPayload.note === "string" && cardPayload.note.length > 0, "honest note must be present");
    assert.ok(cardPayload.note.includes("not archived"), "note explains the missing card body");
    assert.ok(cardPayload.note.includes("search_transcripts"), "note gives the term vertical-retrieval hint");
    assert.ok(!("keyword" in (cardPayload.card ?? {})), "no fabricated card fields");
  }
  const missingCard = parseToolText(
    await client.request("tools/call", { name: "get_card", arguments: { card_id: "no-such-card-id" } }),
  );
  assert.equal(missingCard.isError, true, "unknown card_id must be an error terminal");
  const missingCardPayload = JSON.parse(missingCard.content[0].text) as { error: string };
  assert.ok(missingCardPayload.error.includes("Card not found"), "explainable not-found error");
  console.log(
    `[k] get_card OK: 账本完整（session=${cardPayload.ledger.sessionId}），card=${cardPayload.card === null ? "未归档 + note 降级" : "归档正文 + trace 字段剥离"}，未知 card_id → error 终态`,
  );

  // m) 空结果路径：不存在的 session → 空数组 + total 0（非错误终态）
  const emptyLedger = parseToolText(
    await client.request("tools/call", {
      name: "get_session_ledger",
      arguments: { session_id: "no-such-session" },
    }),
  );
  assert.ok(!emptyLedger.isError, "empty ledger must not be an error terminal");
  const emptyLedgerPayload = JSON.parse(emptyLedger.content[0].text) as GetSessionLedgerPayload;
  assert.deepEqual(emptyLedgerPayload.candidates, [], "empty candidates array");
  assert.equal(emptyLedgerPayload.total, 0);
  assert.deepEqual(emptyLedgerPayload.finalStateSummary, {});
  console.log("[m] 空结果路径 OK: 不存在的 session → 空数组 + total 0（非错误）");

  await client.stop();

  // l) 只读断言（M1 f 模式扩展：文件清单 + sessions/candidates 行数）
  console.log("[l] read-only assertions:");
  assertReadOnly(beforeSnapshot, fixture.dataDir, sessionsBefore, candidatesBefore);
}

async function assertMissingDbServer(): Promise<void> {
  let absentDir = path.join(tmpdir(), "nonexistent-mcp");
  let suffix = 1;
  while (readdirSyncSafe(absentDir)) {
    absentDir = path.join(tmpdir(), `nonexistent-mcp-${suffix}`);
    suffix += 1;
  }
  const client = new McpStdioClient(absentDir, null);
  client.start();
  const initialized = (await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cuemind-mcp-smoke", version: "0.0.1" },
  })) as { serverInfo: { name: string } };
  assert.equal(initialized.serverInfo.name, "cuemind");
  client.notify("notifications/initialized");

  const missing = parseToolText(
    await client.request("tools/call", { name: "list_sessions", arguments: {} }),
  );
  assert.equal(missing.isError, true, "missing db must yield error terminal");
  const payload = JSON.parse(missing.content[0].text) as { error: string };
  assert.ok(
    payload.error.startsWith("cuemind.db not found at") && payload.error.endsWith("Start the CueMind app first."),
    `explainable missing-db error, got: ${payload.error}`,
  );
  const stillResponsive = (await client.request("tools/list", {})) as { tools: unknown[] };
  assert.equal(stillResponsive.tools.length, 6, "server stays responsive after db-missing error");
  assert.ok(client.isAlive(), "server process must not crash");
  await client.stop();
  console.log(`[g] db-missing path OK (CUEMIND_DATA_DIR=${absentDir}): error 终态可解释，server 不崩`);
}

function readdirSyncSafe(dir: string): boolean {
  try {
    statSync(dir);
    return true;
  } catch {
    return false;
  }
}

// --- M3-b：vault 合流（只读）夹具与用例 ---

async function initializeClient(client: McpStdioClient): Promise<void> {
  const initialized = (await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cuemind-mcp-smoke", version: "0.0.1" },
  })) as { serverInfo: { name: string } };
  assert.equal(initialized.serverInfo.name, "cuemind");
  client.notify("notifications/initialized");
}

/** n) 种子 vault：2 个合法概念（frontmatter + 正文 + 变更小节）+ 1 个坏 frontmatter 文件。 */
function seedVaultConcepts(vaultDir: string): void {
  rmSync(vaultDir, { recursive: true, force: true });
  const conceptsDir = path.join(vaultDir, "cuemind", "concepts");
  mkdirSync(conceptsDir, { recursive: true });
  const ringAttention = [
    "---",
    `aliases: ["${VAULT_FIXTURE_TERM}", "${VAULT_FIXTURE_ALIAS_CN}"]`,
    "source_types: [arxiv]",
    `origin_meetings: [${VAULT_FIXTURE_SESSION}]`,
    `updated: ${VAULT_FIXTURE_UPDATED}`,
    "---",
    "",
    `# ${VAULT_FIXTURE_TERM}`,
    "",
    "## 解释",
    "",
    "- Blockwise computation of attention over long sequences.",
    "- 长序列下注意力内存占用随序列长度近似线性增长。",
    "",
    "## 来源",
    "",
    "- [Ring Attention (arXiv)](https://arxiv.org/abs/2310.01889)",
    "  > Blockwise computation of attention over long sequences.",
    "",
    "## 变更 2026-08-28",
    "",
    "- 重新沉淀：更新解释与来源",
    "",
    "- [Ring Attention (arXiv)](https://arxiv.org/abs/2310.01889)",
    "",
  ].join("\n");
  const speculative = [
    "---",
    'aliases: ["speculative decoding", "投机解码"]',
    "source_types: [arxiv, web]",
    "origin_meetings: [m2-smoke]",
    "updated: 2026-08-27T09:00:00.000Z",
    "---",
    "",
    "# speculative decoding",
    "",
    "## 解释",
    "",
    "- Draft model proposes tokens; target model verifies them in parallel.",
    "",
    "## 来源",
    "",
    "- [Speculative Decoding (arXiv)](https://arxiv.org/abs/2211.17192)",
    "  > Fast inference from transformers via speculative decoding.",
    "",
    "## 变更 2026-08-27",
    "",
    "- 重新沉淀：更新解释与来源",
    "",
  ].join("\n");
  // 坏文件：`---` 围栏未闭合 → frontmatter 解析失败 → MCP 侧应跳过该文件且不崩。
  const broken = `---\naliases: ["broken"\n# closing fence missing on purpose\n`;
  writeFileSync(path.join(conceptsDir, "ring-attention.md"), ringAttention, "utf8");
  writeFileSync(path.join(conceptsDir, "speculative-decoding.md"), speculative, "utf8");
  writeFileSync(path.join(conceptsDir, "broken-frontmatter.md"), broken, "utf8");
}

/**
 * M3-b 专用 SQLite 夹具（独立临时目录，绝不写开发 .data）：
 * 账本行 term 与 vault 概念名一致、cards_json 为 NULL（正文未归档）→ 覆盖 get_card 的
 * vault 回退路径与 search_cards 的 SQLite ∪ vault 并存路径。
 */
function prepareVaultFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cuemind-mcp-vault-"));
  const Database = requireSqlite();
  const db = new Database(path.join(dir, "cuemind.db"));
  try {
    // 与主项目 lib/session-store.ts / lib/candidate-store.ts 的 DDL 同款（测试灌种专用）。
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
    db.pragma("journal_mode = DELETE");
    db.prepare(
      "INSERT INTO sessions (id, title, created_at, updated_at, duration_ms, input_source, transcript_json, cards_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(VAULT_FIXTURE_SESSION, "M3 vault 合流冒烟", SEED_CREATED_AT, SEED_CREATED_AT, 15000, "mixed", "[]", null, null);
    db.prepare(
      "INSERT INTO candidates (session_id, candidate_id, term, final_state, suppress_reason, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(VAULT_FIXTURE_SESSION, VAULT_FIXTURE_CANDIDATE_ID, VAULT_FIXTURE_TERM, "card_shown", null, VAULT_FIXTURE_CARD_ID, SEED_CREATED_AT);
  } finally {
    db.close();
  }
  return dir;
}

/** 递归快照：相对路径 → "size/mtimeMs/sha256(内容)"（r 只读断言用）。 */
function snapshotDirRecursive(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      const stats = statSync(full);
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
      snapshot.set(relative, `${stats.size}/${stats.mtimeMs}/${hash}`);
    }
  };
  walk(root, "");
  return snapshot;
}

async function assertVaultMergeServer(vaultDataDir: string, vaultDir: string): Promise<void> {
  // n) 种子 vault（2 个合法概念 + 1 个坏 frontmatter 文件）
  seedVaultConcepts(vaultDir);
  const seededFiles = readdirSync(path.join(vaultDir, "cuemind", "concepts")).sort();
  assert.deepEqual(
    seededFiles,
    ["broken-frontmatter.md", "ring-attention.md", "speculative-decoding.md"],
    "vault fixture files seeded",
  );
  console.log(`[n] vault seeded: ${vaultDir}/cuemind/concepts → ${seededFiles.join(", ")}（含 1 个坏 frontmatter 文件）`);

  // r 基线：种子完成后、MCP 启动前快照（MCP 只读 → 前后必须一致）。
  const vaultBefore = snapshotDirRecursive(vaultDir);

  const client = new McpStdioClient(vaultDataDir, vaultDir);
  client.start();
  await initializeClient(client);

  // o) search_cards 合流：SQLite 命中与 vault 概念命中并存
  const merged = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "Ring Attention" } }),
  );
  const sqliteHit = merged.results.find((hit) => hit.origin === "sqlite");
  const vaultHit = merged.results.find((hit) => hit.origin === "vault");
  assert.ok(sqliteHit !== undefined, "SQLite hit must coexist with vault hits");
  assert.equal(sqliteHit.origin, "sqlite");
  assert.equal(sqliteHit.candidateId, VAULT_FIXTURE_CANDIDATE_ID);
  assert.equal(sqliteHit.term, VAULT_FIXTURE_TERM);
  assert.ok(vaultHit !== undefined, "vault concept hit must appear in merged results");
  assert.equal(vaultHit.origin, "vault");
  assert.equal(vaultHit.source, "vault");
  assert.equal(vaultHit.term, VAULT_FIXTURE_TERM);
  assert.equal(vaultHit.relativePath, "cuemind/concepts/ring-attention.md");
  assert.equal(vaultHit.updated, VAULT_FIXTURE_UPDATED);
  assert.ok(Array.isArray(vaultHit.aliases) && vaultHit.aliases.includes(VAULT_FIXTURE_ALIAS_CN), "aliases must be exposed");
  assert.ok(Array.isArray(vaultHit.originMeetings) && vaultHit.originMeetings.includes(VAULT_FIXTURE_SESSION), "originMeetings must be exposed");
  // alias 命中：中文 alias 只在 vault frontmatter 里，SQLite 账本 term 为英文不应命中。
  const aliasOnly = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: VAULT_FIXTURE_ALIAS_CN } }),
  );
  assert.ok(
    aliasOnly.results.some((hit) => hit.origin === "vault" && hit.term === VAULT_FIXTURE_TERM),
    "vault alias match must hit",
  );
  assert.ok(!aliasOnly.results.some((hit) => hit.origin === "sqlite"), "Chinese alias must not hit the English ledger term");
  console.log(
    `[o] search_cards 合流 OK: origin=sqlite(${sqliteHit.candidateId}) 与 origin=vault(${vaultHit.relativePath}) 并存，aliases=${JSON.stringify(vaultHit.aliases)}，中文 alias 仅命中 vault`,
  );

  // s) 坏 frontmatter 文件跳过：不出现命中、不崩，其余概念仍可检索
  const brokenProbe = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "broken" } }),
  );
  assert.ok(
    !brokenProbe.results.some((hit) => hit.origin === "vault" && hit.relativePath === "cuemind/concepts/broken-frontmatter.md"),
    "broken frontmatter file must be skipped",
  );
  const otherConcept = toolPayload<SearchCardsPayload>(
    await client.request("tools/call", { name: "search_cards", arguments: { query: "投机解码" } }),
  );
  const otherVaultHit = otherConcept.results.find((hit) => hit.origin === "vault");
  assert.ok(
    otherVaultHit !== undefined && otherVaultHit.relativePath === "cuemind/concepts/speculative-decoding.md",
    "remaining concepts stay searchable after skipping the broken file",
  );
  console.log('[s] 坏 frontmatter 跳过 OK: query="broken" 无 vault 命中且不崩，"投机解码" 仍命中 speculative-decoding.md');

  // p) get_card：账本 term 与 vault 概念一致 + 正文未归档 → vault 投影 + note
  const cardResult = parseToolText(
    await client.request("tools/call", { name: "get_card", arguments: { card_id: VAULT_FIXTURE_CARD_ID } }),
  );
  assert.ok(!cardResult.isError, "get_card vault fallback must not be an error terminal");
  const cardPayload = JSON.parse(cardResult.content[0].text) as GetCardPayload;
  assert.equal(cardPayload.ledger.candidateId, VAULT_FIXTURE_CANDIDATE_ID);
  assert.equal(cardPayload.ledger.sessionId, VAULT_FIXTURE_SESSION);
  assert.equal(cardPayload.ledger.term, VAULT_FIXTURE_TERM);
  assert.equal(cardPayload.ledger.cardId, VAULT_FIXTURE_CARD_ID);
  assert.ok(cardPayload.card !== null, "vault fallback must project a card");
  const vaultCard = cardPayload.card as Record<string, unknown>;
  assert.equal(vaultCard.origin, "vault");
  assert.equal(vaultCard.keyword, VAULT_FIXTURE_TERM);
  assert.equal(vaultCard.whyNow, null, "whyNow stays null (never fabricated)");
  assert.equal(vaultCard.relativePath, "cuemind/concepts/ring-attention.md");
  assert.equal(vaultCard.updated, VAULT_FIXTURE_UPDATED);
  assert.ok(Array.isArray(vaultCard.aliases) && (vaultCard.aliases as string[]).includes(VAULT_FIXTURE_ALIAS_CN));
  const keyPoints = vaultCard.keyPoints as string[];
  assert.ok(
    keyPoints.includes("Blockwise computation of attention over long sequences."),
    "keyPoints parsed from body list lines",
  );
  assert.ok(
    !keyPoints.some((point) => point.includes("](http")),
    "source link lines must not leak into keyPoints",
  );
  const sources = vaultCard.sources as Array<{ title: string; url: string }>;
  assert.ok(
    sources.some((source) => source.title === "Ring Attention (arXiv)" && source.url === "https://arxiv.org/abs/2310.01889"),
    "body source lines extracted as [title](url) pairs",
  );
  assert.equal(cardPayload.note, "card body from vault concepts");
  console.log(
    `[p] get_card vault 回退 OK: card.origin=vault，relativePath=${String(vaultCard.relativePath)}，updated=${String(vaultCard.updated)}，note="${cardPayload.note}"`,
  );

  await client.stop();

  // q) CUEMIND_VAULT_DIR 指向不存在目录 → search_cards 仅 SQLite 结果不报错（静默跳过）
  const absentVaultDir = path.join(tmpdir(), "nonexistent-m3-vault");
  rmSync(absentVaultDir, { recursive: true, force: true });
  const absentClient = new McpStdioClient(vaultDataDir, absentVaultDir);
  absentClient.start();
  await initializeClient(absentClient);
  const sqliteOnly = parseToolText(
    await absentClient.request("tools/call", { name: "search_cards", arguments: { query: VAULT_FIXTURE_TERM } }),
  );
  assert.ok(!sqliteOnly.isError, "missing vault must not turn search_cards into an error terminal");
  const sqliteOnlyPayload = JSON.parse(sqliteOnly.content[0].text) as SearchCardsPayload;
  assert.ok(sqliteOnlyPayload.results.length >= 1, "SQLite hit still present without vault");
  assert.ok(
    sqliteOnlyPayload.results.every((hit) => hit.origin === "sqlite"),
    "vault hits silently skipped when CUEMIND_VAULT_DIR points nowhere",
  );
  const honestCard = parseToolText(
    await absentClient.request("tools/call", { name: "get_card", arguments: { card_id: VAULT_FIXTURE_CARD_ID } }),
  );
  assert.ok(!honestCard.isError, "get_card without vault keeps the honest-degradation terminal");
  const honestPayload = JSON.parse(honestCard.content[0].text) as GetCardPayload;
  assert.equal(honestPayload.card, null, "no fabricated vault card when the vault is absent");
  assert.ok(typeof honestPayload.note === "string" && honestPayload.note.includes("not archived"));
  assert.ok(absentClient.isAlive(), "server must not crash when the vault dir is absent");
  await absentClient.stop();
  console.log(
    `[q] vault 缺失静默跳过 OK: CUEMIND_VAULT_DIR=${absentVaultDir} → search_cards 仅 SQLite 结果、get_card 维持诚实降级、server 不崩`,
  );

  // r) 只读断言：vault 目录文件内容+size+mtime 前后不变（MCP 全程无写）
  const vaultAfter = snapshotDirRecursive(vaultDir);
  assert.deepEqual(
    vaultAfter,
    vaultBefore,
    "只读断言失败：vault 目录被 MCP 修改（文件清单/内容/size/mtime 变化）",
  );
  console.log(`[r] vault 只读断言 OK: ${vaultAfter.size} 个文件内容/size/mtime 前后一致（含坏 frontmatter 文件）`);
}

async function main(): Promise<void> {
  statSync(MCP_SERVER_ENTRY);
  const fixture = prepareCandidateFixture();
  const vaultDataDir = prepareVaultFixture();
  try {
    await assertNormalServer(fixture);
    await assertVaultMergeServer(vaultDataDir, VAULT_DIR);
    await assertMissingDbServer();
  } finally {
    // 灌种目录与测试 vault 只存在于临时区，用后即清。
    if (fixture.seeded) rmSync(fixture.dataDir, { recursive: true, force: true });
    rmSync(vaultDataDir, { recursive: true, force: true });
    rmSync(VAULT_DIR, { recursive: true, force: true });
  }
  console.log("test-mcp-server: all assertions passed (a-s)");
}

main().catch((error: unknown) => {
  console.error("test-mcp-server: FAIL", error);
  process.exitCode = 1;
});
