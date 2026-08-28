// Server-side persistence for post-meeting follow-up chat messages.
// Primary backend: better-sqlite3 (WAL mode) at <dataDir>/cuemind.db.
// If the native module cannot be loaded (e.g. node-gyp build failure), falls
// back to an append-only JSONL file with the same API surface. The backend is
// decided once and cached at first use.
//
// Environment overrides:
// - CUEMIND_DATA_DIR: data directory (default: <cwd>/.data)
// - CUEMIND_CHAT_STORE: force "jsonl" to skip the SQLite backend (used by tests)

import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";

export interface StoredChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  isDetail: boolean;
  createdAt: string;
}

export type ChatStoreBackend = "sqlite" | "jsonl";

// Static-side type for better-sqlite3 (@types does not re-export DatabaseConstructor
// from the exported namespace; instance side uses the real `Database` interface).
type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

interface ChatStore {
  backend: ChatStoreBackend;
  append(messages: StoredChatMessage[]): void;
  get(sessionId: string): StoredChatMessage[];
}

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const FORCE_JSONL_ENV = "CUEMIND_CHAT_STORE";
const SQLITE_DB_FILE = "cuemind.db";
const JSONL_FILE = "chat-messages.jsonl";

let cachedStore: ChatStore | null = null;

function resolveDataDir(): string {
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), ".data");
}

function isJsonlForced(): boolean {
  return process.env[FORCE_JSONL_ENV]?.trim().toLowerCase() === "jsonl";
}

// --- SQLite backend ---

interface SqliteRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  isDetail: number;
  createdAt: string;
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

function createSqliteStore(dataDir: string, Database: SqliteDatabaseConstructor): ChatStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, SQLITE_DB_FILE));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      is_detail INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, created_at);
  `);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, is_detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectBySession = db.prepare(
    "SELECT id, session_id AS sessionId, role, content, is_detail AS isDetail, created_at AS createdAt FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
  );
  const appendTx = db.transaction((messages: StoredChatMessage[]) => {
    for (const message of messages) {
      insert.run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.isDetail ? 1 : 0,
        message.createdAt,
      );
    }
  });

  return {
    backend: "sqlite",
    append(messages) {
      if (messages.length === 0) return;
      appendTx(messages);
    },
    get(sessionId) {
      const rows = selectBySession.all(sessionId) as SqliteRow[];
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        role: row.role as StoredChatMessage["role"],
        content: row.content,
        isDetail: row.isDetail === 1,
        createdAt: row.createdAt,
      }));
    },
  };
}

// --- JSONL fallback backend ---

function parseJsonlLine(line: string): StoredChatMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return null;
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
    if (record.role !== "user" && record.role !== "assistant") return null;
    if (typeof record.content !== "string") return null;
    if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return null;
    return {
      id: record.id,
      sessionId: record.sessionId,
      role: record.role,
      content: record.content,
      isDetail: record.isDetail === true,
      createdAt: record.createdAt,
    };
  } catch {
    return null;
  }
}

function createJsonlStore(dataDir: string): ChatStore {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, JSONL_FILE);

  return {
    backend: "jsonl",
    append(messages) {
      if (messages.length === 0) return;
      appendFileSync(file, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    },
    get(sessionId) {
      if (!existsSync(file)) return [];
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return [];
      }
      // Same id may appear multiple times across appends: last line wins.
      const byId = new Map<string, StoredChatMessage>();
      const lastLineIndex = new Map<string, number>();
      const lines = raw.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === "") continue;
        const message = parseJsonlLine(line);
        if (message === null || message.sessionId !== sessionId) continue;
        byId.set(message.id, message);
        lastLineIndex.set(message.id, index);
      }
      return [...byId.values()].sort((a, b) => {
        const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return (lastLineIndex.get(a.id) ?? 0) - (lastLineIndex.get(b.id) ?? 0);
      });
    },
  };
}

// --- singleton access ---

function tryCreateSqliteStore(dataDir: string): ChatStore | null {
  try {
    const Database = loadSqliteConstructor();
    return Database ? createSqliteStore(dataDir, Database) : null;
  } catch {
    return null;
  }
}

function getStore(): ChatStore {
  if (cachedStore !== null) return cachedStore;
  const dataDir = resolveDataDir();
  const store = isJsonlForced() ? null : tryCreateSqliteStore(dataDir);
  cachedStore = store ?? createJsonlStore(dataDir);
  return cachedStore;
}

/** Idempotent upsert by message id. */
export function appendChatMessages(messages: StoredChatMessage[]): void {
  getStore().append(messages);
}

/** Messages of one session in createdAt ascending order. */
export function getChatMessages(sessionId: string): StoredChatMessage[] {
  return getStore().get(sessionId);
}

export function hasChatMessages(sessionId: string): boolean {
  return getStore().get(sessionId).length > 0;
}

/** Diagnostics: which backend is active ("sqlite" primary or "jsonl" fallback). */
export function getChatStoreBackend(): ChatStoreBackend {
  return getStore().backend;
}
