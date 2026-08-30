import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGovernanceVersion } from "../governance.js";
import { errorResult, textResult } from "../db.js";

export function registerGetVaultVersion(server: McpServer): void {
  server.registerTool("get_vault_version", { title: "Get Vault history version", description: "Read-only historical Vault version lookup.", inputSchema: { entry_id: z.string().min(1), version: z.number().int().min(1) } }, (input) => {
    const version = getGovernanceVersion(input.entry_id, input.version);
    return version ? textResult({ entryId: input.entry_id, version }) : errorResult({ error: `Vault version not found: ${input.entry_id}@${input.version}` });
  });
}
