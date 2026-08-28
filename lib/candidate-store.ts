// Server-side persistence for the candidate ledger (M2-a): one row per context
// card attempt keyed by (sessionId, candidateId), written fire-and-forget by the
// context-cards route so card latency is never affected. Primary backend:
// better-sqlite3 (WAL mode) sharing the same <dataDir>/cuemind.db file as
// session-store / chat-store. If the native module cannot be loaded, falls back
// to an append-only JSONL file with the same API surface. The backend is
// decided once and cached at first use.
//
// Environment overrides:
// - CUEMIND_DATA_DIR: data directory (default: <cwd>/.data) — shared with session-store
// - CUEMIND_CANDIDATE_STORE: force "jsonl" to skip the SQLite backend (used by tests)

import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";

export interface StoredCandidate {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  suppressReason: string | null;
  cardId: string | null;
  createdAt: string;
}

export type CandidateStoreBackend = "sqlite" | "jsonl";

// Static-side type for better-sqlite3 (same trick as session-store).
type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

interface CandidateStore {
  backend: CandidateStoreBackend;
  append(candidates: StoredCandidate[]): void;
  getBySession(sessionId: string): StoredCandidate[];
  getByTerm(query: string): StoredCandidate[];
  getByCardId(cardId: string): StoredCandidate | null;
  count(): number;
}

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const FORCE_JSONL_ENV = "CUEMIND_CANDIDATE_STORE";
const SQLITE_DB_FILE = "cuemind.db";
const JSONL_FILE = "candidates.jsonl";

let cachedStore: CandidateStore | null = null;

function resolveDataDir(): string {
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), ".data");
}

function isJsonlForced(): boolean {
  return process.env[FORCE_JSONL_ENV]?.trim().toLowerCase() === "jsonl";
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

const CANDIDATE_COLUMNS =
  "session_id AS sessionId, candidate_id AS candidateId, term, final_state AS finalState, suppress_reason AS suppressReason, card_id AS cardId, created_at AS createdAt";

function rowToCandidate(row: {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  suppressReason: string | null;
  cardId: string | null;
  createdAt: string;
}): StoredCandidate {
  return {
    sessionId: row.sessionId,
    candidateId: row.candidateId,
    term: row.term,
    finalState: row.finalState,
    suppressReason: row.suppressReason,
    cardId: row.cardId,
    createdAt: row.createdAt,
  };
}

function createSqliteStore(dataDir: string, Database: SqliteDatabaseConstructor): CandidateStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, SQLITE_DB_FILE));
  db.pragma("journal_mode = WAL");
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_candidates_session ON candidates(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_candidates_term ON candidates(term);
  `);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO candidates (session_id, candidate_id, term, final_state, suppress_reason, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const appendTx = db.transaction((candidates: StoredCandidate[]) => {
    for (const candidate of candidates) {
      insert.run(
        candidate.sessionId,
        candidate.candidateId,
        candidate.term,
        candidate.finalState,
        candidate.suppressReason,
        candidate.cardId,
        candidate.createdAt,
      );
    }
  });
  const selectBySession = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
  );
  const selectByTerm = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE term LIKE ? ORDER BY created_at ASC, rowid ASC`,
  );
  const selectByCardId = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE card_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  );
  const selectCount = db.prepare("SELECT COUNT(*) AS total FROM candidates");

  return {
    backend: "sqlite",
    append(candidates) {
      appendTx(candidates);
    },
    getBySession(sessionId) {
      return (selectBySession.all(sessionId) as Array<Parameters<typeof rowToCandidate>[0]>).map(rowToCandidate);
    },
    getByTerm(query) {
      const needle = query.trim();
      if (needle.length === 0) return [];
      return (selectByTerm.all(`%${needle}%`) as Array<Parameters<typeof rowToCandidate>[0]>).map(rowToCandidate);
    },
    getByCardId(cardId) {
      const row = selectByCardId.get(cardId) as Parameters<typeof rowToCandidate>[0] | undefined;
      return row ? rowToCandidate(row) : null;
    },
    count() {
      return (selectCount.get() as { total: number }).total;
    },
  };
}

// --- JSONL fallback backend ---

function parseJsonlLine(line: string): StoredCandidate | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
    if (typeof record.candidateId !== "string" || record.candidateId.length === 0) return null;
    if (typeof record.finalState !== "string" || record.finalState.length === 0) return null;
    if (typeof record.createdAt !== "string" || record.createdAt.length === 0) return null;
    return {
      sessionId: record.sessionId,
      candidateId: record.candidateId,
      term: typeof record.term === "string" ? record.term : null,
      finalState: record.finalState,
      suppressReason: typeof record.suppressReason === "string" ? record.suppressReason : null,
      cardId: typeof record.cardId === "string" ? record.cardId : null,
      createdAt: record.createdAt,
    };
  } catch {
    return null;
  }
}

function createJsonlStore(dataDir: string): CandidateStore {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, JSONL_FILE);

  interface JsonlEntry {
    candidate: StoredCandidate;
    lineIndex: number;
  }

  // Same (sessionId, candidateId) may appear across appends: last line wins.
  function readAll(): JsonlEntry[] {
    if (!existsSync(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const byKey = new Map<string, JsonlEntry>();
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      const candidate = parseJsonlLine(line);
      if (candidate === null) continue;
      byKey.set(`${candidate.sessionId}\u0000${candidate.candidateId}`, { candidate, lineIndex: index });
    }
    return [...byKey.values()];
  }

  return {
    backend: "jsonl",
    append(candidates) {
      let payload = "";
      for (const candidate of candidates) payload += `${JSON.stringify(candidate)}\n`;
      appendFileSync(file, payload);
    },
    getBySession(sessionId) {
      return readAll()
        .filter((entry) => entry.candidate.sessionId === sessionId)
        .sort((a, b) => {
          const byCreatedAt = a.candidate.createdAt.localeCompare(b.candidate.createdAt);
          if (byCreatedAt !== 0) return byCreatedAt;
          return a.lineIndex - b.lineIndex;
        })
        .map((entry) => entry.candidate);
    },
    getByTerm(query) {
      const needle = query.trim().toLowerCase();
      if (needle.length === 0) return [];
      return readAll()
        .filter((entry) => entry.candidate.term !== null && entry.candidate.term.toLowerCase().includes(needle))
        .sort((a, b) => {
          const byCreatedAt = a.candidate.createdAt.localeCompare(b.candidate.createdAt);
          if (byCreatedAt !== 0) return byCreatedAt;
          return a.lineIndex - b.lineIndex;
        })
        .map((entry) => entry.candidate);
    },
    getByCardId(cardId) {
      return readAll().find((entry) => entry.candidate.cardId === cardId)?.candidate ?? null;
    },
    count() {
      return readAll().length;
    },
  };
}

// --- singleton access ---

function tryCreateSqliteStore(dataDir: string): CandidateStore | null {
  try {
    const Database = loadSqliteConstructor();
    return Database ? createSqliteStore(dataDir, Database) : null;
  } catch {
    return null;
  }
}

function getStore(): CandidateStore {
  if (cachedStore !== null) return cachedStore;
  const dataDir = resolveDataDir();
  const store = isJsonlForced() ? null : tryCreateSqliteStore(dataDir);
  cachedStore = store ?? createJsonlStore(dataDir);
  return cachedStore;
}

/** Batch INSERT OR REPLACE (transaction); same (sessionId, candidateId) overwrites. Throws on store failure — callers are fire-and-forget and swallow. */
export function appendCandidates(candidates: StoredCandidate[]): void {
  getStore().append(candidates);
}

/** Candidates for one session ordered by createdAt ascending. */
export function getCandidatesBySession(sessionId: string): StoredCandidate[] {
  return getStore().getBySession(sessionId);
}

/** Term substring match, ASCII case-insensitive (SQLite LIKE); empty query returns []. */
export function getCandidatesByTerm(query: string): StoredCandidate[] {
  return getStore().getByTerm(query);
}

/** Reverse lookup by card id (get_card origin-session tracing); null when absent. */
export function getCandidate(cardId: string): StoredCandidate | null {
  return getStore().getByCardId(cardId);
}

/** Read-only total row count (assertions / diagnostics). */
export function countCandidates(): number {
  return getStore().count();
}

/** Diagnostics: which backend is active ("sqlite" primary or "jsonl" fallback). */
export function getCandidateStoreBackend(): CandidateStoreBackend {
  return getStore().backend;
}
