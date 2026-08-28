// get_card：card_id 反查账本行 + 归档卡片正文（若会话快照包含卡片）。
// 数据现实（M2-b）：sessions.cards_json 由主项目写入，当前快照尚无 contextCards 字段，
// 因此卡片正文普遍未归档——此时诚实降级：返回账本记录 + 未归档说明 + term 垂直检索提示，
// 绝不伪造卡片数据。卡片正文归档后走同一查询即可返回完整卡片。
// M3-b 合流：正文未归档（或归档中未命中 card_id）时，只读回退 vault/concepts——
// 以账本行 term 精确匹配概念文件的 term/alias（大小写不敏感 equals），命中则投出
// origin:"vault" 的卡片投影 + note "card body from vault concepts"；vault 目录缺失
// 或无匹配 → 既有诚实降级路径原样保留。全程只读。

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
import { getConcept, resolveVaultRoot, type ConceptFile } from "../vault.js";

/** vault 概念的卡片投影（M3-b）：从概念文件正文白名单解析，不含任何 SQLite/trace 字段。 */
export interface VaultConceptCard {
  keyword: string;
  keyPoints: string[];
  whyNow: null;
  sources: Array<{ title: string; url: string }>;
  origin: "vault";
  relativePath: string;
  updated: string | null;
  aliases: string[];
}

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
  card: PublicContextCard | VaultConceptCard | null;
  note?: string;
}

export const GetCardInputSchema = {
  card_id: z
    .string()
    .min(1)
    .describe("Card id, as exposed by search_cards results or get_session_ledger entries"),
};

// 来源行："- [title](url)"（vault-exporter 的 sourceLines 落盘形态；可带缩进的 "  > snippet" 引用行）。
const SOURCE_LINE_PATTERN = /^-\s*\[([^\]]+)\]\(([^)\s]+)\)/;
const LIST_LINE_PATTERN = /^-\s+(.+)$/;

/** keyPoints：正文列表行（"- " 开头）；来源链接行已单独提取为 sources，不混入。 */
function extractKeyPoints(body: string): string[] {
  const points: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("- ")) continue;
    if (SOURCE_LINE_PATTERN.test(line)) continue;
    const point = LIST_LINE_PATTERN.exec(line);
    if (point !== null && point[1].trim().length > 0) points.push(point[1].trim());
  }
  return points;
}

/** sources：正文来源行的 [title](url) 对（含「## 变更」小节里追加的来源行）。 */
function extractSources(body: string): Array<{ title: string; url: string }> {
  const sources: Array<{ title: string; url: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const match = SOURCE_LINE_PATTERN.exec(rawLine.trimStart());
    if (match === null) continue;
    const title = match[1].trim();
    const url = match[2].trim();
    if (title.length > 0 && url.length > 0) sources.push({ title, url });
  }
  return sources;
}

/** vault 概念 → 卡片投影（whyNow 恒为 null：概念文件无此字段，绝不伪造）。 */
function projectConceptCard(concept: ConceptFile): VaultConceptCard {
  return {
    keyword: concept.term,
    keyPoints: extractKeyPoints(concept.body),
    whyNow: null,
    sources: extractSources(concept.body),
    origin: "vault",
    relativePath: concept.relativePath,
    updated: concept.updated,
    aliases: concept.aliases,
  };
}

export function registerGetCard(server: McpServer): void {
  server.registerTool(
    "get_card",
    {
      title: "Get a CueMind context card",
      description:
        "Look up one context card by id: its ledger record (session/candidate/final state) plus the card body " +
        "resolved from two read-only sources (M3-b): the session-archived card (SQLite cards_json) first, then a " +
        "vault concepts fallback (<vaultRoot>/cuemind/concepts, exact match on the ledger term or alias) marked " +
        'origin:"vault" with note "card body from vault concepts". When neither source has the body, returns an ' +
        "explanatory note and vertical-retrieval hints instead of fabricated data.",
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
          // M3-b 合流：正文未归档（或归档中未命中 card_id）→ 只读回退 vault/concepts
          // 精确匹配（term 来自账本行）；vault 目录缺失或无匹配 → 既有诚实降级不变。
          const ledgerTerm = typeof row.term === "string" && row.term.trim().length > 0 ? row.term : null;
          const vaultRoot = ledgerTerm === null ? null : resolveVaultRoot();
          const concept = ledgerTerm !== null && vaultRoot !== null ? getConcept(vaultRoot, ledgerTerm) : null;
          if (concept !== null) {
            const vaultPayload: GetCardPayload = {
              ledger,
              card: projectConceptCard(concept),
              note: "card body from vault concepts",
            };
            return textResult(vaultPayload);
          }
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
