// get_card：card_id 反查账本行 + 归档卡片正文（若会话快照包含卡片）。
// 数据现实（M2-b）：sessions.cards_json 由主项目写入，当前快照尚无 contextCards 字段，
// 因此卡片正文普遍未归档——此时诚实降级：返回账本记录 + 未归档说明 + term 垂直检索提示，
// 绝不伪造卡片数据。卡片正文归档后走同一查询即可返回完整卡片。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findArchivedCard,
  loadCandidateByCardId,
  loadSessionCardsJson,
  loadSessionTitle,
  type PublicContextCard,
} from "../cards.js";
import { errorResult, openReadonlyDb, textResult, toolFailure } from "../db.js";

interface GetCardPayload {
  ledger: {
    sessionId: string;
    sessionTitle: string | null;
    candidateId: string;
    term: string | null;
    finalState: string;
    suppressReason: string | null;
    cardId: string | null;
    createdAt: string;
  };
  card: PublicContextCard | null;
  note?: string;
}

export const GetCardInputSchema = {
  card_id: z
    .string()
    .min(1)
    .describe("Card id, as exposed by search_cards results or get_session_ledger entries"),
};

export function registerGetCard(server: McpServer): void {
  server.registerTool(
    "get_card",
    {
      title: "Get a CueMind context card",
      description:
        "Look up one context card by id: its ledger record (session/candidate/final state) plus the archived card body when the session snapshot contains it. When the card body is not archived, returns an explanatory note and vertical-retrieval hints instead of fabricated data.",
      inputSchema: GetCardInputSchema,
    },
    (input) => {
      try {
        const db = openReadonlyDb();
        const row = loadCandidateByCardId(db, input.card_id);
        if (row === null) {
          return errorResult({ error: `Card not found: ${input.card_id}` });
        }
        const ledger = {
          sessionId: row.sessionId,
          sessionTitle: loadSessionTitle(db, row.sessionId),
          candidateId: row.candidateId,
          term: row.term,
          finalState: row.finalState,
          suppressReason: row.suppressReason,
          cardId: row.cardId,
          createdAt: row.createdAt,
        };
        const card = findArchivedCard(loadSessionCardsJson(db, row.sessionId), input.card_id);
        if (card === null) {
          const term = row.term ?? row.candidateId;
          const payload: GetCardPayload = {
            ledger,
            card: null,
            note:
              "Card body not archived (the session snapshot does not include archived cards); only the ledger record is available. " +
              `For vertical retrieval of the term, call search_transcripts with query "${term}", ` +
              "or inspect the session transcript via get_session around the recorded time window.",
          };
          return textResult(payload);
        }
        return textResult({ ledger, card } satisfies GetCardPayload);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
