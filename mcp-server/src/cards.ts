// 候选账本（candidates 表）与归档卡片（sessions.cards_json）的只读视图（M2-b）。
// 与主项目保持同步的约定：
// - SQL 与列选择对应 lib/candidate-store.ts（getBySession / getByTerm / getByCardId，只读版）
// - sessions.cards_json 由主项目 lib/session-store.ts 写入：序列化 ContextCard[]
//   （types/suggestions.ts）。当前快照尚无 contextCards 字段，因此现实数据恒为 null；
//   表结构已预留，解析层按"存在即解析、缺失即 null"处理。
// 决策 62（不暴露 trace payload）对卡片的例外：卡片本身是产品数据——keyword/keyPoints/
// whyNow/sources（含 snippet）/时间窗/latency 均可暴露；但 demoTrace、datasetVersion、
// windowingVersion 等 trace/调试字段一律剥离，且绝不输出候选 trace payload。

import type { Database } from "better-sqlite3";

export interface CandidateRow {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  suppressReason: string | null;
  cardId: string | null;
  createdAt: string;
}

export interface CandidateRowWithSessionTitle extends CandidateRow {
  sessionTitle: string | null;
}

// 与 lib/candidate-store.ts 的 CANDIDATE_COLUMNS 保持同步（只读版）。
const CANDIDATE_COLUMNS =
  "c.session_id AS sessionId, c.candidate_id AS candidateId, c.term, c.final_state AS finalState, c.suppress_reason AS suppressReason, c.card_id AS cardId, c.created_at AS createdAt";
const CANDIDATE_WITH_TITLE_COLUMNS = `${CANDIDATE_COLUMNS}, s.title AS sessionTitle`;

/** 候选按会话查（与 candidate-store getBySession 同款：createdAt 升序，rowid 稳定排序）。 */
export function loadCandidatesBySession(db: Database, sessionId: string): CandidateRow[] {
  return db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM candidates c WHERE c.session_id = ? ORDER BY c.created_at ASC, c.rowid ASC`,
    )
    .all(sessionId) as CandidateRow[];
}

/** term 子串匹配（SQLite LIKE 对 ASCII 大小写不敏感）；空 query 返回 []（与 getByTerm 同款）。 */
export function loadCandidatesByTerm(
  db: Database,
  query: string,
  limit: number,
): CandidateRowWithSessionTitle[] {
  const needle = query.trim();
  if (needle.length === 0) return [];
  return db
    .prepare(
      `SELECT ${CANDIDATE_WITH_TITLE_COLUMNS}
       FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
       WHERE c.term LIKE ?
       ORDER BY c.created_at ASC, c.rowid ASC
       LIMIT ?`,
    )
    .all(`%${needle}%`, limit) as CandidateRowWithSessionTitle[];
}

/** 反查：card_id → 账本行（get_card 起点会话溯源；与 getByCardId 同款 LIMIT 1）。 */
export function loadCandidateByCardId(db: Database, cardId: string): CandidateRow | null {
  const row = db
    .prepare(
      `SELECT ${CANDIDATE_COLUMNS} FROM candidates c WHERE c.card_id = ? ORDER BY c.created_at ASC, c.rowid ASC LIMIT 1`,
    )
    .get(cardId) as CandidateRow | undefined;
  return row ?? null;
}

/** card_id 非空的候选行（search_cards 的卡片 keyword 二次匹配扫描用）。 */
export function loadCardCandidates(db: Database): CandidateRowWithSessionTitle[] {
  return db
    .prepare(
      `SELECT ${CANDIDATE_WITH_TITLE_COLUMNS}
       FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
       WHERE c.card_id IS NOT NULL AND c.card_id != ''
       ORDER BY c.created_at ASC, c.rowid ASC`,
    )
    .all() as CandidateRowWithSessionTitle[];
}

export function loadSessionTitle(db: Database, sessionId: string): string | null {
  const row = db.prepare("SELECT title FROM sessions WHERE id = ?").get(sessionId) as
    | { title: string }
    | undefined;
  return row?.title ?? null;
}

export function loadSessionCardsJson(db: Database, sessionId: string): string | null {
  const row = db.prepare("SELECT cards_json AS cardsJson FROM sessions WHERE id = ?").get(sessionId) as
    | { cardsJson: string | null }
    | undefined;
  return row?.cardsJson ?? null;
}

// --- sessions.cards_json 解析（模式与 transcript.ts 的 parseTranscriptChunks 一致） ---

/** 宽类型镜像 types/suggestions.ts 的 ContextCard / ContextCardSource（JSON 反序列化后形状未知，字段逐一守卫）。 */
export interface ContextCardLike {
  id?: unknown;
  keyword?: unknown;
  keyPoints?: unknown;
  explanation?: unknown;
  whyNow?: unknown;
  sources?: unknown;
  coreStartMs?: unknown;
  coreEndMs?: unknown;
  contextStartMs?: unknown;
  contextEndMs?: unknown;
  createdAt?: unknown;
  latencyMs?: unknown;
  [key: string]: unknown;
}

/** 宽容解析 cards_json：非数组/坏 JSON/无 id 的条目一律跳过（只读场景不修复数据）。 */
export function parseCardsJson(cardsJson: string | null): ContextCardLike[] {
  if (cardsJson === null) return [];
  try {
    const parsed: unknown = JSON.parse(cardsJson);
    if (!Array.isArray(parsed)) return [];
    const cards: ContextCardLike[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      // 无 id 的条目无法与账本 card_id 对应，直接跳过。
      if (typeof (item as ContextCardLike).id !== "string") continue;
      cards.push(item as ContextCardLike);
    }
    return cards;
  } catch {
    return [];
  }
}

// --- 白名单投影 ---

export interface PublicCardSource {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
}

export interface PublicContextCard {
  keyword: string;
  whyNow?: string;
  keyPoints?: string[];
  explanation?: string;
  sources: PublicCardSource[];
  evidenceWindow?: {
    coreStartMs: number;
    coreEndMs: number;
    contextStartMs: number;
    contextEndMs: number;
  };
  createdAt?: string;
  latencyMs?: { keyword: number; search: number; generation: number; total: number };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function projectSources(raw: unknown): PublicCardSource[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicCardSource[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.url !== "string") continue;
    const source: PublicCardSource = { title: record.title, url: record.url };
    if (typeof record.snippet === "string") source.snippet = record.snippet;
    if (typeof record.sourceType === "string") source.sourceType = record.sourceType;
    out.push(source);
  }
  return out;
}

/**
 * 卡片白名单投影：keyword 为有效性判据（缺失视为坏条目）。
 * 剥离 id/candidateId/datasetVersion/windowingVersion/demoTrace/transcriptChunkIds 等
 * 账本冗余与 trace/调试字段；sources 的 snippet 保留（产品数据）。
 */
export function projectContextCard(card: ContextCardLike): PublicContextCard | null {
  if (typeof card.keyword !== "string") return null;
  const projected: PublicContextCard = { keyword: card.keyword, sources: projectSources(card.sources) };
  if (typeof card.whyNow === "string") projected.whyNow = card.whyNow;
  if (Array.isArray(card.keyPoints) && card.keyPoints.every((point) => typeof point === "string")) {
    projected.keyPoints = card.keyPoints as string[];
  }
  if (typeof card.explanation === "string") projected.explanation = card.explanation;
  if (
    isFiniteNumber(card.coreStartMs) &&
    isFiniteNumber(card.coreEndMs) &&
    isFiniteNumber(card.contextStartMs) &&
    isFiniteNumber(card.contextEndMs)
  ) {
    projected.evidenceWindow = {
      coreStartMs: card.coreStartMs,
      coreEndMs: card.coreEndMs,
      contextStartMs: card.contextStartMs,
      contextEndMs: card.contextEndMs,
    };
  }
  if (typeof card.createdAt === "string") projected.createdAt = card.createdAt;
  if (typeof card.latencyMs === "object" && card.latencyMs !== null) {
    const latency = card.latencyMs as Record<string, unknown>;
    if (
      isFiniteNumber(latency.keyword) &&
      isFiniteNumber(latency.search) &&
      isFiniteNumber(latency.generation) &&
      isFiniteNumber(latency.total)
    ) {
      projected.latencyMs = {
        keyword: latency.keyword,
        search: latency.search,
        generation: latency.generation,
        total: latency.total,
      };
    }
  }
  return projected;
}

/** 在会话归档卡片中按 id 找卡片正文；未归档/归档损坏返回 null（get_card 的诚实降级判据）。 */
export function findArchivedCard(cardsJson: string | null, cardId: string): PublicContextCard | null {
  for (const card of parseCardsJson(cardsJson)) {
    if (card.id !== cardId) continue;
    return projectContextCard(card);
  }
  return null;
}
