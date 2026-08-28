// CueMind MCP server 的只读 SQLite 访问（M1-b）。
// 与主项目 lib/session-store.ts 保持同步的约定：
// - 同一个 <CUEMIND_DATA_DIR>/cuemind.db（默认 <cwd>/.data，CUEMIND_DATA_DIR 可覆盖）
// - 表结构 sessions / sessions_fts 由主应用负责创建与写入；本进程绝不建表、绝不写库
// 只读打开（readonly: true）：WAL 模式支持多读者，主应用运行期间并发只读安全。
// 决策（任务书）：db 文件缺失时不崩溃启动——工具调用返回可解释错误终态。

import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const SQLITE_DB_FILE = "cuemind.db";

/** 可解释错误终态：db 缺失或无法只读打开（消息仅含路径，不含敏感信息）。 */
export class DbUnavailableError extends Error {}

export function resolveDataDir(): string {
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), ".data");
}

export function resolveDbPath(): string {
  return path.join(resolveDataDir(), SQLITE_DB_FILE);
}

let cachedDb: Database.Database | null = null;

export function openReadonlyDb(): Database.Database {
  if (cachedDb !== null) return cachedDb;
  const file = resolveDbPath();
  if (!existsSync(file)) {
    throw new DbUnavailableError(
      `cuemind.db not found at ${file}. Start the CueMind app first.`,
    );
  }
  try {
    // fileMustExist 与 existsSync 冗余但自文档化；readonly 连接绝不创建文件。
    cachedDb = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DbUnavailableError(
      `Failed to open cuemind.db in read-only mode at ${file}: ${message}`,
    );
  }
  return cachedDb;
}

// --- 工具结果助手（stdout 专属 JSON-RPC；一切日志走 stderr） ---
// 用 type 别名而非 interface：SDK 期望的结果类型带索引签名，type 别名具备隐式索引签名。

export type TextContent = {
  type: "text";
  text: string;
};

export type ToolOk = {
  content: TextContent[];
};

export type ToolError = {
  content: TextContent[];
  isError: true;
};

export function textResult(payload: unknown): ToolOk {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function errorResult(payload: unknown): ToolError {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

/** 统一错误终态：DbUnavailableError 原样透出（可解释）；其余细节只进 stderr，客户端拿通用文案。 */
export function toolFailure(error: unknown): ToolError {
  if (error instanceof DbUnavailableError) {
    return errorResult({ error: error.message });
  }
  console.error("[cuemind-mcp] tool call failed:", error);
  return errorResult({ error: "Internal error while reading cuemind.db (details in server stderr)." });
}
