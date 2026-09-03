// Phase D：知识条目只读访问（MCP 读方向）。
// 数据源与主应用共用 <CUEMIND_DATA_DIR>/cuemind.db 的 knowledge_entries 表
// （表结构由主应用 lib/knowledge-store.ts 创建与写入；本进程绝不建表、绝不写库）。
// 隐私约束：blocked 条目不允许离开本地边界 → 对 MCP 客户端等同不存在；
// 其余条目一律携带 privacy 字段，调用方可自行判断是否进一步使用。
// JSONL fallback 模式下该表不存在 → 返回可解释的空态/错误，而不是崩溃。

import { openReadonlyDb, type ToolError } from "./db.js";

export interface KnowledgeRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  updatedAt: string;
  version: number;
  privacy: string;
  privacyReasons: string[];
  summary: string;
  content: string;
  aliases: string[];
  sourceTypes: string[];
  sourceUrls: string[];
  originSessionIds: string[];
  originCardIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
  vaultExportedVersion: number | null;
  vaultExportedAt: string | null;
}

export class KnowledgeUnavailableError extends Error {}

function assertTable(): void {
  const db = openReadonlyDb();
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'").get() as { name?: string } | undefined;
  if (!row?.name) {
    throw new KnowledgeUnavailableError(
      "knowledge_entries table not found. The CueMind app creates it on first knowledge use (JSONL fallback mode has no SQLite table).",
    );
  }
}

function parseRow(raw: { entry_json: string } | undefined): KnowledgeRow | null {
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw.entry_json) as Record<string, unknown>;
    if (typeof entry.id !== "string") return null;
    const strings = (key: string): string[] => Array.isArray(entry[key]) ? (entry[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
    return {
      id: entry.id,
      slug: typeof entry.slug === "string" ? entry.slug : "",
      title: typeof entry.title === "string" ? entry.title : "",
      status: typeof entry.status === "string" ? entry.status : "active",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      version: typeof entry.version === "number" ? entry.version : 1,
      privacy: typeof entry.privacy === "string" ? entry.privacy : "clear",
      privacyReasons: strings("privacyReasons"),
      summary: typeof entry.summary === "string" ? entry.summary : "",
      content: typeof entry.content === "string" ? entry.content : "",
      aliases: strings("aliases"),
      sourceTypes: strings("sourceTypes"),
      sourceUrls: strings("sourceUrls"),
      originSessionIds: strings("originSessionIds"),
      originCardIds: strings("originCardIds"),
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
      lastUsedAt: typeof entry.lastUsedAt === "string" ? entry.lastUsedAt : null,
      vaultExportedVersion: typeof entry.vaultExportedVersion === "number" ? entry.vaultExportedVersion : null,
      vaultExportedAt: typeof entry.vaultExportedAt === "string" ? entry.vaultExportedAt : null,
    };
  } catch {
    return null;
  }
}

/** 全量读取（上限 10_000 条兜底），过滤 blocked；查询/列表都在其上做内存过滤。 */
function loadRows(): KnowledgeRow[] {
  assertTable();
  const db = openReadonlyDb();
  const rows = db.prepare("SELECT entry_json FROM knowledge_entries LIMIT 10000").all() as Array<{ entry_json: string }>;
  return rows
    .map(parseRow)
    .filter((row): row is KnowledgeRow => row !== null && row.status !== "deleted" && row.privacy !== "blocked");
}

export function listKnowledge(options: { sessionId?: string; status?: string; limit?: number }): KnowledgeRow[] {
  const filtered = loadRows().filter((row) =>
    (options.status === undefined || row.status === options.status)
    && (options.sessionId === undefined || row.originSessionIds.includes(options.sessionId)));
  filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  return filtered.slice(0, options.limit ?? 50);
}

export function getKnowledge(id: string): KnowledgeRow | null {
  return loadRows().find((row) => row.id === id) ?? null;
}

// 与主应用 lib/session-store.ts / lib/knowledge-store.ts 的 bigramTokens 语义保持一致
// （中文 2-gram + ASCII 整词，小写化）。
function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  const cjk = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
  const word = /[A-Za-z0-9_]/;
  let ascii = "";
  let cjkRun = "";
  const flush = (): void => {
    if (ascii.length > 0) { tokens.push(ascii.toLowerCase()); ascii = ""; }
    if (cjkRun.length === 1) tokens.push(cjkRun);
    else if (cjkRun.length > 1) for (let i = 0; i < cjkRun.length - 1; i += 1) tokens.push(cjkRun.slice(i, i + 2));
    cjkRun = "";
  };
  for (const ch of text) {
    if (cjk.test(ch)) { if (ascii.length > 0) { tokens.push(ascii.toLowerCase()); ascii = ""; } cjkRun += ch; }
    else if (word.test(ch)) { if (cjkRun.length > 0) flush(); ascii += ch; }
    else flush();
  }
  flush();
  return tokens;
}

export function searchKnowledge(query: string, options: { sessionId?: string; limit?: number } = {}): Array<{ row: KnowledgeRow; score: number }> {
  const q = query.trim();
  if (!q) return [];
  const tokens = bigramTokens(q);
  if (tokens.length === 0) return [];
  const sessionId = options.sessionId;
  return loadRows()
    .filter((row) => row.status === "active" && (sessionId === undefined || row.originSessionIds.includes(sessionId)))
    .map((row) => {
      const text = [row.title, ...row.aliases, row.summary, row.content].join("\n");
      const haystack = bigramTokens(text);
      const hits = tokens.filter((token) => haystack.includes(token)).length;
      return { row, score: hits / Math.max(tokens.length, 1) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.row.updatedAt.localeCompare(a.row.updatedAt))
    .slice(0, options.limit ?? 20);
}

/** 统一处理 knowledge 表不可用（db 缺失/表缺失）；其余错误交由调用方的 toolFailure。 */
export function knowledgeFailure(error: unknown): ToolError | null {
  if (error instanceof KnowledgeUnavailableError) {
    return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
  }
  return null;
}
