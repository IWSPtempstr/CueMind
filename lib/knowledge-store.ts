import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { bigramTokens } from "@/lib/session-store";

export type KnowledgeStatus = "active" | "archived" | "deleted";

export interface KnowledgeEntry {
  id: string;
  slug: string;
  title: string;
  aliases: string[];
  summary: string;
  content: string;
  sourceTypes: string[];
  sourceUrls: string[];
  originSessionIds: string[];
  originCardIds: string[];
  status: KnowledgeStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  version: number;
}

export interface KnowledgeSearchHit {
  entry: KnowledgeEntry;
  score: number;
}

export interface KnowledgeStore {
  backend: "sqlite" | "jsonl";
  upsert(entry: KnowledgeEntry): void;
  get(id: string): KnowledgeEntry | null;
  list(sessionId?: string): KnowledgeEntry[];
  search(query: string, sessionId?: string): KnowledgeSearchHit[];
  count(): number;
}

const DATA_DIR = () => path.resolve(process.env.CUEMIND_DATA_DIR?.trim() || path.join(process.cwd(), ".data"));
const JSONL = "knowledge-entries.jsonl";
let cached: KnowledgeStore | null = null;

type DatabaseConstructor = new (path: string, options?: { timeout?: number }) => SqliteDatabase;

function loadDatabase(): DatabaseConstructor | null {
  if (process.env.CUEMIND_KNOWLEDGE_STORE?.trim().toLowerCase() === "jsonl") return null;
  try {
    return createRequire(path.join(process.cwd(), "package.json"))("better-sqlite3") as DatabaseConstructor;
  } catch { return null; }
}

function validEntry(value: unknown): KnowledgeEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (["id", "slug", "title", "summary", "content", "createdAt", "updatedAt"].some((key) => typeof r[key] !== "string")) return null;
  if (r.status !== "active" && r.status !== "archived" && r.status !== "deleted") return null;
  const strings = (key: string): string[] => Array.isArray(r[key]) ? r[key].filter((item): item is string => typeof item === "string") : [];
  return {
    id: r.id as string, slug: r.slug as string, title: r.title as string,
    aliases: strings("aliases"), summary: r.summary as string, content: r.content as string,
    sourceTypes: strings("sourceTypes"), sourceUrls: strings("sourceUrls"),
    originSessionIds: strings("originSessionIds"), originCardIds: strings("originCardIds"),
    status: r.status, createdAt: r.createdAt as string, updatedAt: r.updatedAt as string,
    lastUsedAt: typeof r.lastUsedAt === "string" ? r.lastUsedAt : null,
    version: typeof r.version === "number" && Number.isInteger(r.version) ? r.version : 1,
  };
}

function sortEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

function createJsonlStore(dir: string): KnowledgeStore {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, JSONL);
  const read = (): Map<string, KnowledgeEntry> => {
    const map = new Map<string, KnowledgeEntry>();
    if (!existsSync(file)) return map;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      try { const entry = validEntry(JSON.parse(line)); if (entry) map.set(entry.id, entry); } catch { /* skip malformed append */ }
    }
    return map;
  };
  return {
    backend: "jsonl",
    upsert(entry) { appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8"); },
    get(id) { return read().get(id) ?? null; },
    list(sessionId) { return sortEntries([...read().values()].filter((e) => !sessionId || e.originSessionIds.includes(sessionId))); },
    search(query, sessionId) { return searchEntries([...read().values()], query, sessionId); },
    count() { return read().size; },
  };
}

function searchEntries(entries: KnowledgeEntry[], query: string, sessionId?: string): KnowledgeSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const tokens = bigramTokens(q);
  return entries.filter((entry) => entry.status === "active" && (!sessionId || entry.originSessionIds.includes(sessionId))).map((entry) => {
    const text = [entry.title, ...entry.aliases, entry.summary, entry.content].join("\n");
    const hits = tokens.filter((token) => bigramTokens(text).includes(token)).length;
    return { entry, score: hits / Math.max(tokens.length, 1) };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt)).slice(0, 100);
}

function createSqliteStore(dir: string, Database: DatabaseConstructor): KnowledgeStore {
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "cuemind.db"), { timeout: 5000 });
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_entries (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, entry_json TEXT NOT NULL, title TEXT NOT NULL, search_text TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_knowledge_entries_status ON knowledge_entries(status, updated_at);`);
  const put = db.prepare("INSERT OR REPLACE INTO knowledge_entries (id, slug, entry_json, title, search_text, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const select = db.prepare("SELECT entry_json AS entryJson FROM knowledge_entries WHERE id = ?");
  const list = db.prepare("SELECT entry_json AS entryJson FROM knowledge_entries WHERE status != 'deleted' ORDER BY updated_at DESC");
  const all = db.prepare("SELECT entry_json AS entryJson FROM knowledge_entries");
  return {
    backend: "sqlite",
    upsert(entry) { put.run(entry.id, entry.slug, JSON.stringify(entry), entry.title, bigramTokens([entry.title, ...entry.aliases, entry.summary, entry.content].join("\n")).join(" "), entry.status, entry.updatedAt); },
    get(id) { const row = select.get(id) as { entryJson: string } | undefined; return row ? validEntry(JSON.parse(row.entryJson)) : null; },
    list(sessionId) { return sortEntries((list.all() as Array<{ entryJson: string }>).map((r) => validEntry(JSON.parse(r.entryJson))).filter((e): e is KnowledgeEntry => e !== null && (!sessionId || e.originSessionIds.includes(sessionId)))); },
    search(query, sessionId) { return searchEntries((all.all() as Array<{ entryJson: string }>).map((r) => validEntry(JSON.parse(r.entryJson))).filter((e): e is KnowledgeEntry => e !== null), query, sessionId); },
    count() { return (all.all() as unknown[]).length; },
  };
}

export function getKnowledgeStore(): KnowledgeStore {
  if (!cached) cached = loadDatabase() ? createSqliteStore(DATA_DIR(), loadDatabase() as DatabaseConstructor) : createJsonlStore(DATA_DIR());
  return cached;
}

export function resetKnowledgeStoreForTests(): void { cached = null; }
