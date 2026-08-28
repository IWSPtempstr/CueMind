// Server-side persistence for session snapshots (M1 groundwork for the
// knowledge-export MCP). Primary backend: better-sqlite3 (WAL mode) sharing the
// same <dataDir>/cuemind.db file as chat-store, plus an FTS5 index for search.
// If the native module cannot be loaded (e.g. node-gyp build failure), falls
// back to an append-only JSONL file with the same API surface. The backend is
// decided once and cached at first use.
//
// Environment overrides:
// - CUEMIND_DATA_DIR: data directory (default: <cwd>/.data) — shared with chat-store
// - CUEMIND_SESSION_STORE: force "jsonl" to skip the SQLite backend (used by tests)

import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";

export type UnknownRecord = Record<string, unknown>;

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  inputSource: string | null;
  /** Serialized TranscriptChunk[] (full fidelity). */
  transcriptJson: string;
  /** Serialized ContextCard[]; null until SessionSnapshot carries contextCards. */
  cardsJson: string | null;
  /** Serialized latency metrics; null until SessionSnapshot carries latencySamples. */
  metricsJson: string | null;
}

export type SessionStoreBackend = "sqlite" | "jsonl";

export interface SessionListOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export interface SessionSearchHit {
  session: StoredSession;
  score: number;
}

// Static-side type for better-sqlite3 (@types does not re-export DatabaseConstructor
// from the exported namespace; instance side uses the real `Database` interface).
type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

interface SessionStore {
  backend: SessionStoreBackend;
  upsert(session: StoredSession): void;
  list(opts: SessionListOptions): StoredSession[];
  get(id: string): StoredSession | null;
  search(query: string): SessionSearchHit[];
}

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const FORCE_JSONL_ENV = "CUEMIND_SESSION_STORE";
const SQLITE_DB_FILE = "cuemind.db";
const JSONL_FILE = "sessions.jsonl";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const MAX_SEARCH_HITS = 100;
// CJK 统一表意文字（含扩展 A 区）；与 bigramTokens 的字符判定保持一致。
const CJK_CHAR_PATTERN = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
const ASCII_WORD_CHAR_PATTERN = /[A-Za-z0-9_]/;

let cachedStore: SessionStore | null = null;

function resolveDataDir(): string {
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), ".data");
}

function isJsonlForced(): boolean {
  return process.env[FORCE_JSONL_ENV]?.trim().toLowerCase() === "jsonl";
}

/**
 * 中文 2-gram 切分：CJK 字符两两成词（单独成串的单字自成一词），
 * ASCII 词按空白/标点切整词（小写化）。用于 FTS5 默认分词器下可用的中文检索。
 */
export function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  let asciiRun = "";
  let cjkRun = "";
  const flushAscii = (): void => {
    if (asciiRun.length > 0) {
      tokens.push(asciiRun.toLowerCase());
      asciiRun = "";
    }
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      tokens.push(cjkRun);
    } else if (cjkRun.length > 1) {
      for (let index = 0; index < cjkRun.length - 1; index += 1) {
        tokens.push(cjkRun.slice(index, index + 2));
      }
    }
    cjkRun = "";
  };
  for (const char of text) {
    if (CJK_CHAR_PATTERN.test(char)) {
      flushAscii();
      cjkRun += char;
    } else if (ASCII_WORD_CHAR_PATTERN.test(char)) {
      flushCjk();
      asciiRun += char;
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return tokens;
}

// --- snapshot extraction ---

function extractIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/**
 * 宽类型安全提取：缺 id/title 或 transcriptChunks 非数组时抛 Error
 * （调用方为 fire-and-forget，catch 后静默；HTTP 路由转 400）。
 */
export function buildStoredSession(snapshot: UnknownRecord): StoredSession {
  const id = typeof snapshot.id === "string" ? snapshot.id.trim() : "";
  if (id.length === 0) throw new Error("session snapshot requires a non-empty id");
  const title = typeof snapshot.title === "string" ? snapshot.title.trim() : "";
  if (title.length === 0) throw new Error("session snapshot requires a non-empty title");
  if (!Array.isArray(snapshot.transcriptChunks)) {
    throw new Error("session snapshot requires transcriptChunks to be an array");
  }
  const chunks = snapshot.transcriptChunks;

  const createdAt = extractIso(snapshot.createdAt) ?? new Date().toISOString();
  const updatedAt = extractIso(snapshot.updatedAt) ?? createdAt;

  let minStartMs: number | null = null;
  let maxEndMs: number | null = null;
  const sources = new Set<string>();
  const transcriptTexts: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk !== "object" || chunk === null) continue;
    const record = chunk as UnknownRecord;
    if (typeof record.text === "string" && record.text.length > 0) transcriptTexts.push(record.text);
    if (typeof record.startMs === "number" && Number.isFinite(record.startMs)) {
      minStartMs = minStartMs === null ? record.startMs : Math.min(minStartMs, record.startMs);
    }
    if (typeof record.endMs === "number" && Number.isFinite(record.endMs)) {
      maxEndMs = maxEndMs === null ? record.endMs : Math.max(maxEndMs, record.endMs);
    }
    if (typeof record.source === "string" && record.source.length > 0) sources.add(record.source);
  }
  const durationMs = minStartMs !== null || maxEndMs !== null
    ? Math.max((maxEndMs ?? 0) - (minStartMs ?? 0), 0)
    : null;
  const inputSource = sources.size === 0 ? null : sources.size === 1 ? [...sources][0] : "mixed";

  // SessionSnapshot 当前不含 contextCards / latencySamples：缺省即 null，保留扩展位。
  const cardsJson = Array.isArray(snapshot.contextCards) ? JSON.stringify(snapshot.contextCards) : null;
  let metricsJson: string | null = null;
  if (Array.isArray(snapshot.latencySamples)) {
    metricsJson = JSON.stringify(snapshot.latencySamples);
  } else if (typeof snapshot.metrics === "object" && snapshot.metrics !== null) {
    metricsJson = JSON.stringify(snapshot.metrics);
  }

  return {
    id,
    title,
    createdAt,
    updatedAt,
    durationMs,
    inputSource,
    transcriptJson: JSON.stringify(chunks),
    cardsJson,
    metricsJson,
  };
}

function transcriptText(transcriptJson: string): string {
  try {
    const parsed: unknown = JSON.parse(transcriptJson);
    if (!Array.isArray(parsed)) return "";
    const texts: string[] = [];
    for (const chunk of parsed) {
      if (typeof chunk !== "object" || chunk === null) continue;
      const text = (chunk as UnknownRecord).text;
      if (typeof text === "string") texts.push(text);
    }
    return texts.join("\n");
  } catch {
    return "";
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const normalized = Math.round(limit);
  if (normalized < 1) return 1;
  return Math.min(normalized, MAX_LIST_LIMIT);
}

// --- SQLite backend ---

interface SqliteRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  inputSource: string | null;
  transcriptJson: string;
  cardsJson: string | null;
  metricsJson: string | null;
}

// createRequire is used instead of a static import so a broken native build
// degrades to the JSONL backend instead of crashing the module graph.
function loadSqliteConstructor(): SqliteDatabaseConstructor | null {
  if (isJsonlForced()) return null;
  try {
    const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
    return nodeRequire("better-sqlite3") as SqliteDatabaseConstructor;
  } catch {
    return null;
  }
}

function rowToSession(row: SqliteRow): StoredSession {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    durationMs: row.durationMs,
    inputSource: row.inputSource,
    transcriptJson: row.transcriptJson,
    cardsJson: row.cardsJson,
    metricsJson: row.metricsJson,
  };
}

const SESSION_COLUMNS =
  "id, title, created_at AS createdAt, updated_at AS updatedAt, duration_ms AS durationMs, input_source AS inputSource, transcript_json AS transcriptJson, cards_json AS cardsJson, metrics_json AS metricsJson";

function createSqliteStore(dataDir: string, Database: SqliteDatabaseConstructor): SessionStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, SQLITE_DB_FILE));
  db.pragma("journal_mode = WAL");
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
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title, transcript_text, content='');
  `);

  const selectExisting = db.prepare(
    "SELECT rowid AS rowid, title, transcript_json AS transcriptJson FROM sessions WHERE id = ?",
  );
  const upsert = db.prepare(
    "INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at, duration_ms, input_source, transcript_json, cards_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const ftsInsert = db.prepare(
    "INSERT INTO sessions_fts (rowid, title, transcript_text) VALUES (?, ?, ?)",
  );
  // content='' 的 contentless FTS5 表不能直接 DELETE，需用 'delete' 命令并回放
  // 原始分词内容（由 title/transcriptJson 确定性重算，保证与写入时一致）。
  const ftsDelete = db.prepare(
    "INSERT INTO sessions_fts (sessions_fts, rowid, title, transcript_text) VALUES ('delete', ?, ?, ?)",
  );
  const selectById = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`);
  const searchFts = db.prepare(
    `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt,
            s.duration_ms AS durationMs, s.input_source AS inputSource,
            s.transcript_json AS transcriptJson, s.cards_json AS cardsJson,
            s.metrics_json AS metricsJson, bm25(sessions_fts) AS rank
     FROM sessions s JOIN sessions_fts ON sessions_fts.rowid = s.rowid
     WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?`,
  );

  const upsertTx = db.transaction((session: StoredSession) => {
    const titleTokens = bigramTokens(session.title).join(" ");
    const transcriptTokens = bigramTokens(transcriptText(session.transcriptJson)).join(" ");
    const existing = selectExisting.get(session.id) as
      | { rowid: number; title: string; transcriptJson: string }
      | undefined;
    if (existing) {
      ftsDelete.run(
        existing.rowid,
        bigramTokens(existing.title).join(" "),
        bigramTokens(transcriptText(existing.transcriptJson)).join(" "),
      );
    }
    // INSERT OR REPLACE 重建行 → rowid 变化，FTS 同步删旧插新并绑定新 rowid。
    const info = upsert.run(
      session.id,
      session.title,
      session.createdAt,
      session.updatedAt,
      session.durationMs,
      session.inputSource,
      session.transcriptJson,
      session.cardsJson,
      session.metricsJson,
    );
    ftsInsert.run(info.lastInsertRowid, titleTokens, transcriptTokens);
  });

  return {
    backend: "sqlite",
    upsert(session) {
      upsertTx(session);
    },
    list(opts) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (opts.from !== undefined && opts.from.length > 0) {
        clauses.push("updated_at >= ?");
        params.push(opts.from);
      }
      if (opts.to !== undefined && opts.to.length > 0) {
        clauses.push("updated_at <= ?");
        params.push(opts.to);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(resolveLimit(opts.limit));
      const rows = db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params) as SqliteRow[];
      return rows.map(rowToSession);
    },
    get(id) {
      const row = selectById.get(id) as SqliteRow | undefined;
      return row ? rowToSession(row) : null;
    },
    search(query) {
      const matchQuery = bigramTokens(query).join(" ");
      if (matchQuery.length === 0) return [];
      const rows = searchFts.all(matchQuery, MAX_SEARCH_HITS) as Array<SqliteRow & { rank: number }>;
      return rows.map((row) => ({
        session: rowToSession(row),
        // bm25() 越负越相关 → 取反使 score 越大越相关（与 JSONL 命中次数语义对齐）。
        score: -row.rank,
      }));
    },
  };
}

// --- JSONL fallback backend ---

function parseJsonlLine(line: string): StoredSession | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    if (typeof record.title !== "string") return null;
    if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return null;
    if (typeof record.updatedAt !== "string" || record.updatedAt.length === 0) return null;
    if (typeof record.transcriptJson !== "string") return null;
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
      inputSource: typeof record.inputSource === "string" ? record.inputSource : null,
      transcriptJson: record.transcriptJson,
      cardsJson: typeof record.cardsJson === "string" ? record.cardsJson : null,
      metricsJson: typeof record.metricsJson === "string" ? record.metricsJson : null,
    };
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

function createJsonlStore(dataDir: string): SessionStore {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, JSONL_FILE);

  interface JsonlEntry {
    session: StoredSession;
    lineIndex: number;
  }

  function readAll(): JsonlEntry[] {
    if (!existsSync(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    // Same id may appear multiple times across appends: last line wins.
    const byId = new Map<string, JsonlEntry>();
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      const session = parseJsonlLine(line);
      if (session === null) continue;
      byId.set(session.id, { session, lineIndex: index });
    }
    return [...byId.values()];
  }

  return {
    backend: "jsonl",
    upsert(session) {
      appendFileSync(file, `${JSON.stringify(session)}\n`);
    },
    list(opts) {
      const from = opts.from;
      const to = opts.to;
      const entries = readAll().filter((entry) => {
        if (from !== undefined && from.length > 0 && entry.session.updatedAt < from) return false;
        if (to !== undefined && to.length > 0 && entry.session.updatedAt > to) return false;
        return true;
      });
      entries.sort((a, b) => {
        const byUpdatedAt = b.session.updatedAt.localeCompare(a.session.updatedAt);
        if (byUpdatedAt !== 0) return byUpdatedAt;
        return b.lineIndex - a.lineIndex;
      });
      return entries.slice(0, resolveLimit(opts.limit)).map((entry) => entry.session);
    },
    get(id) {
      return readAll().find((entry) => entry.session.id === id)?.session ?? null;
    },
    search(query) {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return [];
      const hits: SessionSearchHit[] = [];
      for (const entry of readAll()) {
        const score =
          countOccurrences(entry.session.title.toLowerCase(), needle) +
          countOccurrences(entry.session.transcriptJson.toLowerCase(), needle);
        if (score > 0) hits.push({ session: entry.session, score });
      }
      hits.sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore !== 0) return byScore;
        return b.session.updatedAt.localeCompare(a.session.updatedAt);
      });
      return hits.slice(0, MAX_SEARCH_HITS);
    },
  };
}

// --- singleton access ---

function tryCreateSqliteStore(dataDir: string): SessionStore | null {
  try {
    const Database = loadSqliteConstructor();
    return Database ? createSqliteStore(dataDir, Database) : null;
  } catch {
    return null;
  }
}

function getStore(): SessionStore {
  if (cachedStore !== null) return cachedStore;
  const dataDir = resolveDataDir();
  const store = isJsonlForced() ? null : tryCreateSqliteStore(dataDir);
  cachedStore = store ?? createJsonlStore(dataDir);
  return cachedStore;
}

/** Idempotent upsert by session id; throws on invalid snapshots (fire-and-forget callers swallow). */
export function upsertSession(snapshot: UnknownRecord): void {
  getStore().upsert(buildStoredSession(snapshot));
}

/** Sessions ordered by updatedAt descending, limit default 20 / max 100. */
export function listSessions(opts: SessionListOptions = {}): StoredSession[] {
  return getStore().list(opts);
}

export function getSession(id: string): StoredSession | null {
  return getStore().get(id);
}

/** FTS5 (bigram) hits ranked by bm25; empty query returns []. */
export function searchSessions(query: string): SessionSearchHit[] {
  return getStore().search(query);
}

/** Diagnostics: which backend is active ("sqlite" primary or "jsonl" fallback). */
export function getSessionStoreBackend(): SessionStoreBackend {
  return getStore().backend;
}
