// get_session：会话元数据 + 转写分页（默认 50 chunks/页，最大 200）。
// 转写来自 sessions.transcript_json（写入侧由主项目 lib/session-store.ts upsert 时序列化）。
// 不存在的 id → 可解释错误终态；chunk 输出走白名单（不暴露 latency 等 trace 字段）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, openReadonlyDb, textResult, toolFailure } from "../db.js";
import { parseTranscriptChunks, toPublicChunk } from "../transcript.js";

const DEFAULT_PAGE_LIMIT = 50;

const SESSION_METADATA_COLUMNS =
  "id, title, created_at AS createdAt, updated_at AS updatedAt, duration_ms AS durationMs, input_source AS inputSource";

interface SessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  inputSource: string | null;
  transcriptJson: string;
}

export const GetSessionInputSchema = {
  session_id: z
    .string()
    .min(1)
    .describe("Session id, as returned by list_sessions or search_transcripts"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Transcript chunk offset to start from (default 0)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Transcript chunks per page (default 50, max 200)"),
};

export function registerGetSession(server: McpServer): void {
  server.registerTool(
    "get_session",
    {
      title: "Get a CueMind session",
      description:
        "Fetch one CueMind session: metadata plus its transcript in pages. Returns { session, chunks, total, offset, limit, hasMore }; chunks are whitelisted fields (text/timing/source), never raw audio or trace payloads.",
      inputSchema: GetSessionInputSchema,
    },
    (input) => {
      try {
        const db = openReadonlyDb();
        const row = db
          .prepare(
            `SELECT ${SESSION_METADATA_COLUMNS}, transcript_json AS transcriptJson FROM sessions WHERE id = ?`,
          )
          .get(input.session_id) as SessionRow | undefined;
        if (row === undefined) {
          return errorResult({ error: `Session not found: ${input.session_id}` });
        }
        const chunks = parseTranscriptChunks(row.transcriptJson);
        const offset = input.offset ?? 0;
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const page = chunks.slice(offset, offset + limit).map(toPublicChunk);
        return textResult({
          session: {
            id: row.id,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            durationMs: row.durationMs,
            inputSource: row.inputSource,
            transcriptChars: row.transcriptJson.length,
          },
          chunks: page,
          total: chunks.length,
          offset,
          limit,
          hasMore: offset + limit < chunks.length,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
