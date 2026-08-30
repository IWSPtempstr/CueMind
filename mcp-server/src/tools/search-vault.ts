import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchGovernance } from "../governance.js";
import { textResult } from "../db.js";

export function registerSearchVault(server: McpServer): void {
  server.registerTool("search_vault", { title: "Search governed Vault entries", description: "Read-only keyword search over active Vault versions; pending, conflicting and withdrawn versions are excluded.", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() } }, (input) => {
    const results = searchGovernance(input.query).slice(0, input.limit ?? 10).map((entry) => ({ entryId: entry.entryId, currentVersion: entry.currentVersion, conflictIds: entry.conflictIds, version: entry.versions.find((v) => v.version === entry.currentVersion) }));
    return textResult({ query: input.query, results });
  });
}
