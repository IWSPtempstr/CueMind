import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { bigramTokens } from "@/lib/session-store";
import {
  buildMemoryAliasKeys,
  isMemoryRecordEligible,
  normalizeMemoryKey,
  type KnowledgeCardRecord,
  type MemoryHit,
  type MemoryKind,
  type MemoryRecord,
  type MeetingDecisionRecord,
} from "@/lib/knowledge-memory";

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const FORCE_JSONL_ENV = "CUEMIND_KNOWLEDGE_MEMORY_STORE";
const SQLITE_DB_FILE = "cuemind.db";
const JSONL_FILE = "knowledge-memory.jsonl";
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 20;

export type KnowledgeMemoryBackend = "sqlite" | "jsonl";

export interface KnowledgeMemorySearchOptions {
  query: string;
  kind?: MemoryKind;
  limit?: number;
  at?: Date | string;
}

export interface KnowledgeMemoryStore {
  backend: KnowledgeMemoryBackend;
  clear(): void;
  upsert(records: MemoryRecord[]): void;
  search(options: KnowledgeMemorySearchOptions): MemoryHit[];
  count(): number;
}

type SqliteDatabaseConstructor = new (path: string, options?: { timeout?: number }) => SqliteDatabase;

function resolveDataDir(): string {
  const configured = process.env[DATA_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), ".data");
}

function forceJsonl(): boolean {
  return process.env[FORCE_JSONL_ENV]?.trim().toLowerCase() === "jsonl";
}

function loadSqliteConstructor(): SqliteDatabaseConstructor | null {
  if (forceJsonl()) return null;
  try {
    const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
    return nodeRequire("better-sqlite3") as SqliteDatabaseConstructor;
  } catch {
    return null;
  }
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.round(limit), 1), MAX_LIMIT);
}

function recordTitle(record: MemoryRecord): string {
  return record.kind === "knowledge_card" ? record.keyword : "会议决定";
}

function recordContent(record: MemoryRecord): string {
  if (record.kind === "knowledge_card") {
    return [record.explanation, ...(record.keyPoints ?? [])].filter(Boolean).join("\n");
  }
  return [record.decision, record.scope ?? ""].filter(Boolean).join("\n");
}

function recordSearchText(record: MemoryRecord): string {
  const aliases = record.kind === "knowledge_card" ? record.aliases : [];
  return [recordTitle(record), ...aliases, recordContent(record)].join("\n");
}

function toHit(record: MemoryRecord, score: number, matchedBy: MemoryHit["matchedBy"], key: string): MemoryHit {
  return {
    id: record.id,
    kind: record.kind,
    score,
    matchedBy,
    key,
    title: recordTitle(record),
    content: recordContent(record),
    originMeeting: record.originMeeting,
    status: record.status,
    validUntil: record.validUntil ?? null,
    updatedAt: record.updatedAt,
    record,
  };
}

function parseRecord(value: unknown): MemoryRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
  if (record.kind !== "knowledge_card" && record.kind !== "meeting_decision") return null;
  if (typeof record.originMeeting !== "string" || typeof record.status !== "string") return null;
  if (typeof record.updatedAt !== "string" || typeof record.createdAt !== "string") return null;
  if (record.kind === "knowledge_card") {
    if (typeof record.keyword !== "string" || typeof record.explanation !== "string") return null;
    return {
      id: record.id,
      kind: "knowledge_card",
      keyword: record.keyword,
      aliases: Array.isArray(record.aliases) ? record.aliases.filter((item): item is string => typeof item === "string") : [],
      explanation: record.explanation,
      keyPoints: Array.isArray(record.keyPoints) ? record.keyPoints.filter((item): item is string => typeof item === "string") : undefined,
      sourceUrls: Array.isArray(record.sourceUrls) ? record.sourceUrls.filter((item): item is string => typeof item === "string") : undefined,
      originMeeting: record.originMeeting,
      evidenceChunkIds: Array.isArray(record.evidenceChunkIds) ? record.evidenceChunkIds.filter((item): item is string => typeof item === "string") : undefined,
      status: record.status as KnowledgeCardRecord["status"],
      validUntil: typeof record.validUntil === "string" ? record.validUntil : record.validUntil === null ? null : undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  if (typeof record.decision !== "string") return null;
  return {
    id: record.id,
    kind: "meeting_decision",
    decision: record.decision,
    scope: typeof record.scope === "string" ? record.scope : record.scope === null ? null : undefined,
    originMeeting: record.originMeeting,
    evidenceChunkIds: Array.isArray(record.evidenceChunkIds) ? record.evidenceChunkIds.filter((item): item is string => typeof item === "string") : undefined,
    decidedAt: typeof record.decidedAt === "string" ? record.decidedAt : record.createdAt,
    validUntil: typeof record.validUntil === "string" ? record.validUntil : record.validUntil === null ? null : undefined,
    status: record.status as MeetingDecisionRecord["status"],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function memoryMatch(record: MemoryRecord, query: string): { matchedBy: MemoryHit["matchedBy"]; key: string } | null {
  const normalizedQuery = normalizeMemoryKey(query);
  if (normalizedQuery.length === 0) return null;
  const keys = buildMemoryAliasKeys(record.kind === "knowledge_card" ? record.keyword : "", record.kind === "knowledge_card" ? record.aliases : []);
  if (keys.includes(normalizedQuery)) {
    return { matchedBy: keys[0] === normalizedQuery ? "exact" : "alias", key: normalizedQuery };
  }
  return null;
}

function parseJsonl(file: string): Map<string, MemoryRecord> {
  const latest = new Map<string, MemoryRecord>();
  if (!existsSync(file)) return latest;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = parseRecord(JSON.parse(line));
      if (record) latest.set(record.id, record);
    } catch {
      // Ignore malformed append-only lines; later valid records remain usable.
    }
  }
  return latest;
}

function createJsonlStore(dataDir: string): KnowledgeMemoryStore {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, JSONL_FILE);
  const records = (): Map<string, MemoryRecord> => parseJsonl(file);
  return {
    backend: "jsonl",
    clear() {
      writeFileSync(file, "", "utf8");
    },
    upsert(next) {
      if (next.length === 0) return;
      appendFileSync(file, `${next.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    },
    search(options) {
      const query = options.query.trim();
      if (!query) return [];
      const limit = resolveLimit(options.limit);
      const results: MemoryHit[] = [];
      for (const record of records().values()) {
        if (options.kind && record.kind !== options.kind) continue;
        if (!isMemoryRecordEligible(record, options.at)) continue;
        const exact = memoryMatch(record, query);
        if (exact) {
          results.push(toHit(record, exact.matchedBy === "exact" ? 100 : 90, exact.matchedBy, exact.key));
          continue;
        }
        const tokens = bigramTokens(query);
        const haystack = bigramTokens(recordSearchText(record));
        const tokenHits = tokens.filter((token) => haystack.includes(token)).length;
        if (tokenHits > 0) results.push(toHit(record, tokenHits / Math.max(tokens.length, 1), "fts", normalizeMemoryKey(query)));
      }
      return results.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
    },
    count() {
      return records().size;
    },
  };
}

interface MemoryRow {
  id: string;
  kind: MemoryKind;
  recordJson: string;
}

function createSqliteStore(dataDir: string, Database: SqliteDatabaseConstructor): KnowledgeMemoryStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, SQLITE_DB_FILE), { timeout: 5_000 });
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_memory (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      record_json TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      valid_until TEXT,
      origin_meeting TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_memory_keys (
      key TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (key, id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_memory_status ON knowledge_memory(status, valid_until);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_memory_fts USING fts5(id UNINDEXED, search_text);
  `);

  const upsertRow = db.prepare("INSERT OR REPLACE INTO knowledge_memory (id, kind, record_json, title, content, status, valid_until, origin_meeting, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const deleteKeys = db.prepare("DELETE FROM knowledge_memory_keys WHERE id = ?");
  const insertKey = db.prepare("INSERT OR IGNORE INTO knowledge_memory_keys (key, id) VALUES (?, ?)");
  const deleteFts = db.prepare("DELETE FROM knowledge_memory_fts WHERE id = ?");
  const insertFts = db.prepare("INSERT INTO knowledge_memory_fts (id, search_text) VALUES (?, ?)");
  const upsertTx = db.transaction((records: MemoryRecord[]) => {
    for (const record of records) {
      upsertRow.run(record.id, record.kind, JSON.stringify(record), recordTitle(record), recordContent(record), record.status, record.validUntil ?? null, record.originMeeting, record.updatedAt);
      deleteKeys.run(record.id);
      for (const key of buildMemoryAliasKeys(record.kind === "knowledge_card" ? record.keyword : "", record.kind === "knowledge_card" ? record.aliases : [])) insertKey.run(key, record.id);
      deleteFts.run(record.id);
      insertFts.run(record.id, bigramTokens(recordSearchText(record)).join(" "));
    }
  });
  const exactRows = db.prepare("SELECT m.id, m.kind, m.record_json AS recordJson FROM knowledge_memory m JOIN knowledge_memory_keys k ON k.id = m.id WHERE k.key = ?");
  const ftsRows = db.prepare("SELECT m.id, m.kind, m.record_json AS recordJson, bm25(knowledge_memory_fts) AS rank FROM knowledge_memory_fts f JOIN knowledge_memory m ON m.id = f.id WHERE knowledge_memory_fts MATCH ? ORDER BY rank LIMIT ?");

  const rowRecord = (row: MemoryRow): MemoryRecord | null => {
    try { return parseRecord(JSON.parse(row.recordJson)); } catch { return null; }
  };
  return {
    backend: "sqlite",
    clear() {
      db.exec("DELETE FROM knowledge_memory_keys; DELETE FROM knowledge_memory_fts; DELETE FROM knowledge_memory;");
    },
    upsert(records) {
      if (records.length > 0) upsertTx(records);
    },
    search(options) {
      const query = options.query.trim();
      if (!query) return [];
      const limit = resolveLimit(options.limit);
      const byId = new Map<string, MemoryHit>();
      const exactKey = normalizeMemoryKey(query);
      for (const row of exactRows.all(exactKey) as MemoryRow[]) {
        const record = rowRecord(row);
        if (!record || (options.kind && record.kind !== options.kind) || !isMemoryRecordEligible(record, options.at)) continue;
        const exact = memoryMatch(record, query);
        if (exact) byId.set(record.id, toHit(record, exact.matchedBy === "exact" ? 100 : 90, exact.matchedBy, exact.key));
      }
      const ftsQuery = bigramTokens(query).join(" ");
      if (ftsQuery.length > 0) {
        for (const row of ftsRows.all(ftsQuery, limit * 4) as Array<MemoryRow & { rank: number }>) {
          const record = rowRecord(row);
          if (!record || byId.has(record.id) || (options.kind && record.kind !== options.kind) || !isMemoryRecordEligible(record, options.at)) continue;
          byId.set(record.id, toHit(record, Math.max(0, -row.rank), "fts", normalizeMemoryKey(query)));
        }
      }
      return [...byId.values()].sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
    },
    count() {
      return (db.prepare("SELECT COUNT(*) AS total FROM knowledge_memory").get() as { total: number }).total;
    },
  };
}

let cachedStore: KnowledgeMemoryStore | null = null;

export function getKnowledgeMemoryStore(): KnowledgeMemoryStore {
  if (cachedStore) return cachedStore;
  const dataDir = resolveDataDir();
  const Database = loadSqliteConstructor();
  cachedStore = Database ? createSqliteStore(dataDir, Database) : createJsonlStore(dataDir);
  return cachedStore;
}

/** Test-only reset so each fixture can choose a fresh data directory/backend. */
export function resetKnowledgeMemoryStoreForTests(): void {
  cachedStore = null;
}
