// search_transcripts：query 侧 2-gram 化 → FTS5 MATCH → bm25 排序 → 命中摘要。
// 与主项目 lib/session-store.ts 的 searchSessions 保持同步：
// - matchQuery = bigramTokens(query).join(" ")（空格为 FTS5 隐式 AND；token 只含
//   CJK/ASCII word 字符，无 FTS 语法字符，拼接安全）
// - bm25() 越负越相关，ORDER BY rank 升序即最相关在前
// 每个命中返回 { sessionId, title, updatedAt, matchedExcerpt }，不回传完整转写。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bigramTokens } from "../bigram.js";
import { openReadonlyDb, textResult, toolFailure } from "../db.js";
import { buildExcerpt } from "../transcript.js";

const DEFAULT_SEARCH_LIMIT = 10;

interface SearchRow {
  id: string;
  title: string;
  updatedAt: string;
  transcriptJson: string;
  rank: number;
}

export const SearchTranscriptsInputSchema = {
  query: z
    .string()
    .min(1)
    .describe("Free-text query; CJK input is tokenized into 2-grams to match the write-side FTS index"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max hits to return (default 10, max 50)"),
};

export function registerSearchTranscripts(server: McpServer): void {
  server.registerTool(
    "search_transcripts",
    {
      title: "Search CueMind transcripts",
      description:
        "Full-text search across CueMind session titles and transcripts (Chinese works via 2-gram tokenization). Returns hits with sessionId/title/updatedAt and a short matchedExcerpt around the first match.",
      inputSchema: SearchTranscriptsInputSchema,
    },
    (input) => {
      try {
        const tokens = bigramTokens(input.query);
        // 与主项目一致：分不出任何 token（纯标点/空白）时返回空结果集。
        if (tokens.length === 0) {
          return textResult({ query: input.query, results: [] });
        }
        const db = openReadonlyDb();
        const matchQuery = tokens.join(" ");
        const rows = db
          .prepare(
            `SELECT s.id, s.title, s.updated_at AS updatedAt, s.transcript_json AS transcriptJson,
                    bm25(sessions_fts) AS rank
             FROM sessions s JOIN sessions_fts ON sessions_fts.rowid = s.rowid
             WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(matchQuery, input.limit ?? DEFAULT_SEARCH_LIMIT) as SearchRow[];
        const firstToken = tokens[0] ?? "";
        const results = rows.map((row) => ({
          sessionId: row.id,
          title: row.title,
          updatedAt: row.updatedAt,
          matchedExcerpt: buildExcerpt(row.transcriptJson, firstToken, row.title),
        }));
        return textResult({ query: input.query, results });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
