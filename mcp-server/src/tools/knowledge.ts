// Phase D：只读知识检索工具（计划 §10 MCP scope，共 5 个）。
// 硬约束：只读——不写库、不触发同步、不删除；blocked 条目在数据访问层即被过滤，
// 任何工具都拿不到；会话作用域由可选 session_id 参数收窄（本地单用户模型，无令牌体系）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, textResult } from "../db.js";
import { getKnowledge, knowledgeFailure, listKnowledge, searchKnowledge } from "../knowledge.js";

function present(row: ReturnType<typeof getKnowledge>): Record<string, unknown> {
  if (!row) return {};
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    aliases: row.aliases,
    summary: row.summary,
    status: row.status,
    privacy: row.privacy,
    privacyReasons: row.privacyReasons,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    vaultExportedVersion: row.vaultExportedVersion,
    vaultExportedAt: row.vaultExportedAt,
  };
}

export function registerKnowledgeTools(server: McpServer): void {
  server.registerTool("list_knowledge_entries", {
    title: "List knowledge entries",
    description: "Read-only listing of active/archived knowledge entries; blocked and deleted entries are never returned.",
    inputSchema: {
      session_id: z.string().min(1).optional(),
      status: z.enum(["active", "archived"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, (input) => {
    try {
      const entries = listKnowledge({ sessionId: input.session_id, status: input.status, limit: input.limit }).map(present);
      return textResult({ entries });
    } catch (error) {
      const handled = knowledgeFailure(error);
      if (handled) return handled;
      throw error;
    }
  });

  server.registerTool("get_knowledge_entry", {
    title: "Get knowledge entry",
    description: "Read-only full lookup by entry id; blocked entries are indistinguishable from missing ones.",
    inputSchema: { entry_id: z.string().min(1) },
  }, (input) => {
    try {
      const row = getKnowledge(input.entry_id);
      return row ? textResult({ entry: { ...present(row), content: row.content } }) : errorResult({ error: `Knowledge entry not found: ${input.entry_id}` });
    } catch (error) {
      const handled = knowledgeFailure(error);
      if (handled) return handled;
      throw error;
    }
  });

  server.registerTool("search_knowledge", {
    title: "Search knowledge entries",
    description: "Read-only keyword search (CJK bigram + ASCII words) over active entries; blocked entries are excluded.",
    inputSchema: {
      query: z.string().min(1),
      session_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, (input) => {
    try {
      const results = searchKnowledge(input.query, { sessionId: input.session_id, limit: input.limit })
        .map(({ row, score }) => ({ entry: present(row), score }));
      return textResult({ query: input.query, results });
    } catch (error) {
      const handled = knowledgeFailure(error);
      if (handled) return handled;
      throw error;
    }
  });

  server.registerTool("get_knowledge_versions", {
    title: "Get knowledge entry version info",
    description: "Read-only version metadata (current version, vault export version, timestamps) for one entry.",
    inputSchema: { entry_id: z.string().min(1) },
  }, (input) => {
    try {
      const row = getKnowledge(input.entry_id);
      return row
        ? textResult({ entryId: row.id, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, privacy: row.privacy, vaultExportedVersion: row.vaultExportedVersion, vaultExportedAt: row.vaultExportedAt })
        : errorResult({ error: `Knowledge entry not found: ${input.entry_id}` });
    } catch (error) {
      const handled = knowledgeFailure(error);
      if (handled) return handled;
      throw error;
    }
  });

  server.registerTool("get_knowledge_sources", {
    title: "Get knowledge entry sources",
    description: "Read-only source metadata (source URLs/types, origin sessions and cards) for one entry.",
    inputSchema: { entry_id: z.string().min(1) },
  }, (input) => {
    try {
      const row = getKnowledge(input.entry_id);
      return row
        ? textResult({ entryId: row.id, sourceTypes: row.sourceTypes, sourceUrls: row.sourceUrls, originSessionIds: row.originSessionIds, originCardIds: row.originCardIds })
        : errorResult({ error: `Knowledge entry not found: ${input.entry_id}` });
    } catch (error) {
      const handled = knowledgeFailure(error);
      if (handled) return handled;
      throw error;
    }
  });
}
