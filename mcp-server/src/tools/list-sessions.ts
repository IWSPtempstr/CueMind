// list_sessions：会话元数据列表（updatedAt 倒序），不回传完整转写载荷。
// SQL 与列选择和主项目 lib/session-store.ts 的 listSessions 保持同步（只读版）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openReadonlyDb, textResult, toolFailure } from "../db.js";

const DEFAULT_LIST_LIMIT = 20;

const SESSION_SUMMARY_COLUMNS =
  "id, title, created_at AS createdAt, updated_at AS updatedAt, duration_ms AS durationMs, input_source AS inputSource, LENGTH(transcript_json) AS transcriptChars";

interface SessionSummaryRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  inputSource: string | null;
  transcriptChars: number;
}

export const ListSessionsInputSchema = {
  from: z
    .string()
    .min(1)
    .optional()
    .describe("ISO timestamp lower bound on updatedAt (inclusive)"),
  to: z
    .string()
    .min(1)
    .optional()
    .describe("ISO timestamp upper bound on updatedAt (inclusive)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max sessions to return (default 20, max 100)"),
};

export function registerListSessions(server: McpServer): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List CueMind sessions",
      description:
        "List CueMind session metadata (id/title/createdAt/updatedAt/durationMs/inputSource/transcriptChars), newest first. Never returns transcript payloads.",
      inputSchema: ListSessionsInputSchema,
    },
    (input) => {
      try {
        const db = openReadonlyDb();
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        if (input.from !== undefined) {
          clauses.push("updated_at >= ?");
          params.push(input.from);
        }
        if (input.to !== undefined) {
          clauses.push("updated_at <= ?");
          params.push(input.to);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        params.push(input.limit ?? DEFAULT_LIST_LIMIT);
        const rows = db
          .prepare(
            `SELECT ${SESSION_SUMMARY_COLUMNS} FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(...params) as SessionSummaryRow[];
        return textResult({ sessions: rows });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
