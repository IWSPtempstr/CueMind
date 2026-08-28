// get_session_ledger：单个会话的候选账本流水（createdAt 升序）+ final_state 汇总。
// 与 lib/candidate-store.ts getBySession 同款排序（createdAt ASC，rowid 稳定排序）。
// 无任何账本记录 → 空数组 + total 0（非错误终态）：账本与会话快照生命周期独立。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadCandidatesBySession } from "../cards.js";
import { openReadonlyDb, textResult, toolFailure } from "../db.js";

interface GetSessionLedgerPayload {
  sessionId: string;
  candidates: Array<{
    candidateId: string;
    term: string | null;
    finalState: string;
    suppressReason: string | null;
    cardId: string | null;
    createdAt: string;
  }>;
  total: number;
  finalStateSummary: Record<string, number>;
}

export const GetSessionLedgerInputSchema = {
  session_id: z
    .string()
    .min(1)
    .describe("Session id, as returned by list_sessions or search_transcripts"),
};

export function registerGetSessionLedger(server: McpServer): void {
  server.registerTool(
    "get_session_ledger",
    {
      title: "Get a CueMind session's candidate ledger",
      description:
        "List every context-card candidate recorded for one session in creation order, with a final-state summary. Sessions without ledger records return an empty list (not an error).",
      inputSchema: GetSessionLedgerInputSchema,
    },
    (input) => {
      try {
        const db = openReadonlyDb();
        const rows = loadCandidatesBySession(db, input.session_id);
        const candidates = rows.map((row) => ({
          candidateId: row.candidateId,
          term: row.term,
          finalState: row.finalState,
          suppressReason: row.suppressReason,
          cardId: row.cardId,
          createdAt: row.createdAt,
        }));
        const finalStateSummary: Record<string, number> = {};
        for (const candidate of candidates) {
          finalStateSummary[candidate.finalState] = (finalStateSummary[candidate.finalState] ?? 0) + 1;
        }
        const payload: GetSessionLedgerPayload = {
          sessionId: input.session_id,
          candidates,
          total: candidates.length,
          finalStateSummary,
        };
        return textResult(payload);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
