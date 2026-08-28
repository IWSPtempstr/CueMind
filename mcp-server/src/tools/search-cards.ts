// search_cards：候选账本 term 子串检索（大小写不敏感）+ 归档卡片 keyword 二次匹配合并（去重）
// + vault 概念合流（M3-b，只读）。
// 主路径：candidates.term LIKE '%query%'（与 lib/candidate-store.ts getByTerm 同款语义），
// LEFT JOIN sessions 取 title（账本行可能早于/独立于会话快照，故必须 LEFT JOIN 而非 INNER JOIN）。
// 二次路径：card_id 非空的候选，若其会话归档卡片（sessions.cards_json）中对应卡片的
// keyword 命中 query，也并入结果（覆盖 term 为 NULL 或不匹配的行）。
// M3-b 合流：SQLite 命中（origin:"sqlite"，向后兼容新增字段）∪ 只读 vault 概念命中
// （origin:"vault"，另有 source:"vault" 标记；term/aliases/updated/relativePath/originMeetings
// 透出，term 或 aliases 大小写不敏感 includes，同 term slug 同名去重），合并后统一 limit；
// vault 目录不存在 → 静默跳过 vault 源（非错误）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  loadCandidatesByTerm,
  loadCardCandidates,
  loadSessionCardsJson,
  parseCardsJson,
} from "../cards.js";
import { openReadonlyDb, textResult, toolFailure } from "../db.js";
import { resolveVaultRoot, searchConcepts } from "../vault.js";

const DEFAULT_SEARCH_LIMIT = 10;

interface SearchCardHit {
  origin: "sqlite";
  candidateId: string;
  sessionId: string;
  sessionTitle: string | null;
  term: string | null;
  finalState: string;
  cardId: string | null;
  createdAt: string;
}

/** vault 概念命中（M3-b）：与 SQLite 行字段结构不同，以 origin 区分。 */
interface VaultConceptHit {
  origin: "vault";
  source: "vault";
  term: string;
  aliases: string[];
  updated: string | null;
  relativePath: string;
  originMeetings: string[];
}

interface CandidateRowWithSessionTitle {
  sessionId: string;
  candidateId: string;
  term: string | null;
  finalState: string;
  suppressReason: string | null;
  cardId: string | null;
  createdAt: string;
  sessionTitle: string | null;
}

function toHit(row: CandidateRowWithSessionTitle): SearchCardHit {
  return {
    origin: "sqlite",
    candidateId: row.candidateId,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    term: row.term,
    finalState: row.finalState,
    cardId: row.cardId,
    createdAt: row.createdAt,
  };
}

export const SearchCardsInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Substring matched against candidate terms (SQL LIKE, ASCII case-insensitive), archived card keywords, and vault concept terms/aliases (case-insensitive)",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max hits to return (default 10, max 50)"),
};

export function registerSearchCards(server: McpServer): void {
  server.registerTool(
    "search_cards",
    {
      title: "Search CueMind context-card candidates",
      description:
        "Search the candidate ledger by term substring, plus a secondary match against archived card keywords. " +
        'Data sources (M3-b): SQLite candidates/sessions (rows carry origin:"sqlite") merged with the read-only ' +
        "vault concept export <vaultRoot>/cuemind/concepts/*.md (hits carry origin:\"vault\" plus source:\"vault\", " +
        "exposing term/aliases/updated/relativePath/originMeetings; matched by term or alias, case-insensitive; " +
        "skipped silently when the vault directory is absent). Results are capped by limit after the merge. " +
        "Never returns trace payloads.",
      inputSchema: SearchCardsInputSchema,
    },
    (input) => {
      try {
        const needle = input.query.trim();
        if (needle.length === 0) {
          return textResult({ query: input.query, results: [] });
        }
        const db = openReadonlyDb();
        const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
        const byKey = new Map<string, SearchCardHit>();
        // 主路径：term LIKE 命中在前。
        for (const row of loadCandidatesByTerm(db, needle, limit)) {
          byKey.set(`${row.sessionId}\u0000${row.candidateId}`, toHit(row));
        }
        // 二次路径：归档卡片 keyword 命中（term 为 NULL 或不含 query 的候选也能通过卡片命中）。
        const lowerNeedle = needle.toLowerCase();
        const cardsJsonBySession = new Map<string, string | null>();
        for (const row of loadCardCandidates(db)) {
          const key = `${row.sessionId}\u0000${row.candidateId}`;
          if (byKey.has(key) || row.cardId === null) continue;
          if (!cardsJsonBySession.has(row.sessionId)) {
            cardsJsonBySession.set(row.sessionId, loadSessionCardsJson(db, row.sessionId));
          }
          const cards = parseCardsJson(cardsJsonBySession.get(row.sessionId) ?? null);
          const keyword = cards.find((card) => card.id === row.cardId)?.keyword;
          if (typeof keyword !== "string" || !keyword.toLowerCase().includes(lowerNeedle)) continue;
          byKey.set(key, toHit(row));
        }
        // M3-b 合流：SQLite ∪ vault/concepts（只读）。vault root 缺失 → 静默跳过；
        // vault 命中去重（同 term slug 同名）在 searchConcepts 内完成；合并后统一 limit。
        const results: Array<SearchCardHit | VaultConceptHit> = [...byKey.values()];
        const vaultRoot = resolveVaultRoot();
        if (vaultRoot !== null) {
          for (const concept of searchConcepts(vaultRoot, needle)) {
            results.push({
              origin: "vault",
              source: "vault",
              term: concept.term,
              aliases: concept.aliases,
              updated: concept.updated,
              relativePath: concept.relativePath,
              originMeetings: concept.originMeetings,
            });
          }
        }
        return textResult({ query: input.query, results: results.slice(0, limit) });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
