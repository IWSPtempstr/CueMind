/**
 * Contracts for the two kinds of knowledge that may be carried into a later
 * meeting. The records are deliberately independent of the storage backend;
 * SQLite/JSONL stores may serialize them without changing their semantics.
 */

export type MemoryKind = "knowledge_card" | "meeting_decision";

/** A record is reusable only while it is active and its optional expiry has not passed. */
export type MemoryRecordStatus = "active" | "superseded" | "disputed" | "archived";

export interface KnowledgeCardRecord {
  id: string;
  kind: "knowledge_card";
  keyword: string;
  aliases: string[];
  explanation: string;
  keyPoints?: string[];
  sourceUrls?: string[];
  originMeeting: string;
  evidenceChunkIds?: string[];
  status: MemoryRecordStatus;
  validUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingDecisionRecord {
  id: string;
  kind: "meeting_decision";
  decision: string;
  scope?: string | null;
  originMeeting: string;
  evidenceChunkIds?: string[];
  decidedAt: string;
  validUntil?: string | null;
  status: MemoryRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export type MemoryRecord = KnowledgeCardRecord | MeetingDecisionRecord;

export type MemoryMatchType = "exact" | "alias" | "fts";

/** Canonical shape returned by later exact/alias/FTS retrieval layers. */
export interface MemoryHit {
  id: string;
  kind: MemoryKind;
  score: number;
  matchedBy: MemoryMatchType;
  /** Normalized key that produced this hit. */
  key: string;
  title: string;
  content: string;
  originMeeting: string;
  status: MemoryRecordStatus;
  validUntil: string | null;
  updatedAt: string;
  record: MemoryRecord;
}

// Treat whitespace and the common Unicode dash variants as the same key
// separator. NFKC handles full-width ASCII forms before this pass.
const MEMORY_DASH_PATTERN = /[\u058a\u05be\u1400\u1806\u2010-\u2015\u2e17\u2e1a\u2e3a\u2e3b\u2e40\u301c\u3030\u30a0\ufe31\ufe32\ufe58\ufe63\uff0d-]/gu;

/**
 * Build a deterministic lookup key for a keyword or alias.
 *
 * NFKC makes compatibility forms equivalent (for example full-width Latin),
 * lower-casing makes ASCII case irrelevant, and every run of whitespace or
 * dash punctuation becomes one ASCII hyphen. Empty/whitespace-only input
 * returns an empty key so callers can safely discard it.
 */
export function normalizeMemoryKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(MEMORY_DASH_PATTERN, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Return canonical keyword + alias lookup keys in stable input order.
 * Normalized duplicates and empty aliases are omitted.
 */
export function buildMemoryAliasKeys(keyword: unknown, aliases: readonly unknown[] = []): string[] {
  const keys: string[] = [];
  for (const candidate of [keyword, ...aliases]) {
    const key = normalizeMemoryKey(candidate);
    if (key.length > 0 && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Alias retained for callers that describe the operation as key extraction. */
export const memoryAliasKeys = buildMemoryAliasKeys;

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Whether a record may be presented as current historical context at `at`.
 * Invalid expiry timestamps fail closed; a missing/null expiry is unbounded.
 */
export function isMemoryRecordEligible(record: Pick<MemoryRecord, "status" | "validUntil">, at: Date | string = new Date()): boolean {
  if (record.status !== "active") return false;
  const validUntil = record.validUntil;
  if (validUntil === undefined || validUntil === null || validUntil.trim().length === 0) return true;
  if (!isValidDate(validUntil)) return false;
  const atDate = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(atDate.getTime())) return false;
  return new Date(validUntil).getTime() >= atDate.getTime();
}

/** Explicit alias for code that uses “current” rather than “eligible”. */
export const isCurrentMemoryRecord = isMemoryRecordEligible;

