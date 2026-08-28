import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// mcp-server（M1-b，本地只读 stdio MCP）spawn 自测。
// 不依赖 MCP SDK 客户端：child_process.spawn 直接起 node mcp-server/dist/index.js，
// 按 MCP stdio 约定（换行分隔 JSON-RPC，stdout 上不得出现任何非 JSON-RPC 内容）收发。
// 断言：
//   a) initialize 返回 serverInfo
//   b) tools/list 含三个工具
//   c) list_sessions 返回元数据数组（无 transcriptJson/cardsJson/metricsJson 载荷）
//   d) get_session offset/limit 分页正确（total/hasMore），不存在 id → 可解释错误终态，
//      chunk 白名单剥离 latency（trace payload）
//   e) search_transcripts 中文 query 命中（2-gram），含 matchedExcerpt
//   f) 只读断言：调用前后 .data 文件清单一致、无新增文件、cuemind.db 主文件 size+mtime
//      不变（-shm/-wal mtime 允许因读触碰）、sessions 行数不变
//   g) db 缺失路径：CUEMIND_DATA_DIR=/tmp/nonexistent-mcp → 工具返回可解释 error 终态且 server 不崩
// 前置：cd CueMind && (cd mcp-server && npm install && npm run build)；dev server :3000 在跑且
// .data 已有种子数据（mcp-seed-a=7 chunks / mcp-seed-b=5 chunks，见仓库 README 或灌数脚本）。

const PROJECT_ROOT = process.cwd();
const MCP_SERVER_ENTRY = path.join(PROJECT_ROOT, "mcp-server", "dist", "index.js");
const DATA_DIR = path.resolve(".data");
const DB_FILE = path.join(DATA_DIR, "cuemind.db");
const REQUEST_TIMEOUT_MS = 20_000;

const SEED_A = "mcp-seed-a";
const SEED_B = "mcp-seed-b";

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

/** 极简 MCP stdio 客户端：换行分隔 JSON-RPC，按 id 匹配响应。 */
class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  constructor(private readonly dataDir: string) {}

  start(): void {
    this.child = spawn(process.execPath, [MCP_SERVER_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CUEMIND_DATA_DIR: this.dataDir },
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

function snapshotDataDir(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const name of readdirSync(DATA_DIR).sort()) {
    const stats = statSync(path.join(DATA_DIR, name));
    snapshot.set(name, `${stats.size}/${stats.mtimeMs}`);
  }
  return snapshot;
}

function sessionsRowCount(): number {
  const requireFromProject = createRequire(path.join(PROJECT_ROOT, "package.json"));
  const Database = requireFromProject("better-sqlite3") as new (
    file: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => { prepare: (sql: string) => { get: () => { n: number } }; close: () => void };
  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  } finally {
    db.close();
  }
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

function assertReadOnly(before: Map<string, string>, rowCountBefore: number): void {
  const after = snapshotDataDir();
  const rowCountAfter = sessionsRowCount();
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
  assert.equal(rowCountAfter, rowCountBefore, "只读断言失败：sessions 行数变化");
  console.log(`  sessions 行数: before=${rowCountBefore} after=${rowCountAfter}（一致）`);
}

function assertSessionSummary(item: Record<string, unknown>): void {
  for (const key of ["id", "title", "createdAt", "updatedAt", "durationMs", "inputSource", "transcriptChars"]) {
    assert.ok(key in item, `summary missing field: ${key}`);
  }
  for (const forbidden of ["transcriptJson", "cardsJson", "metricsJson"]) {
    assert.ok(!(forbidden in item), `summary must not expose ${forbidden}`);
  }
}

async function assertNormalServer(): Promise<void> {
  const beforeSnapshot = snapshotDataDir();
  const rowCountBefore = sessionsRowCount();
  const client = new McpStdioClient(DATA_DIR);
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

  await client.stop();

  // f) 只读断言（调用后与调用前对比）
  console.log("[f] read-only assertions:");
  assertReadOnly(beforeSnapshot, rowCountBefore);
}

async function assertMissingDbServer(): Promise<void> {
  let absentDir = path.join(tmpdir(), "nonexistent-mcp");
  let suffix = 1;
  while (readdirSyncSafe(absentDir)) {
    absentDir = path.join(tmpdir(), `nonexistent-mcp-${suffix}`);
    suffix += 1;
  }
  const client = new McpStdioClient(absentDir);
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
  assert.equal(stillResponsive.tools.length, 3, "server stays responsive after db-missing error");
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

async function main(): Promise<void> {
  statSync(MCP_SERVER_ENTRY);
  await assertNormalServer();
  await assertMissingDbServer();
  console.log("test-mcp-server: all assertions passed (a-g)");
}

main().catch((error: unknown) => {
  console.error("test-mcp-server: FAIL", error);
  process.exitCode = 1;
});
