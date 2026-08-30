import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGovernanceEntry } from "../governance.js";
import { errorResult, textResult } from "../db.js";

export function registerGetVaultEntry(server: McpServer): void {
  server.registerTool("get_vault_entry", { title: "Get current Vault entry", description: "Read-only current-version lookup by entryId.", inputSchema: { entry_id: z.string().min(1) } }, (input) => {
    const entry = getGovernanceEntry(input.entry_id);
    return entry ? textResult({ entryId: entry.entryId, currentVersion: entry.currentVersion, conflictIds: entry.conflictIds, version: entry.currentVersion === null ? null : entry.versions.find((v) => v.version === entry.currentVersion) }) : errorResult({ error: `Vault entry not found: ${input.entry_id}` });
  });
}
