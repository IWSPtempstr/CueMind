// CueMind 本地知识导出 MCP server（M1-b）：stdio transport，全程只读（决策 62）。
// 硬约束：
// - stdout 专属 JSON-RPC，绝不向 stdout 打任何非协议内容（下方有 console.log 保险丝）
// - 一切日志走 stderr（console.error）
// - 零出站网络：本进程不发起任何 HTTP/网络请求
// - 只读：SQLite readonly 打开；vault（M3-b 读方向）仅 statSync/readdirSync/readFileSync，无任何写路径

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetCard } from "./tools/get-card.js";
import { registerGetSession } from "./tools/get-session.js";
import { registerGetSessionLedger } from "./tools/get-session-ledger.js";
import { registerListSessions } from "./tools/list-sessions.js";
import { registerSearchCards } from "./tools/search-cards.js";
import { registerSearchTranscripts } from "./tools/search-transcripts.js";
import { registerSearchVault } from "./tools/search-vault.js";
import { registerGetVaultEntry } from "./tools/get-vault-entry.js";
import { registerGetVaultVersion } from "./tools/get-vault-version.js";

const SERVER_NAME = "cuemind";
const SERVER_VERSION = "0.1.0";

// 保险丝：即便后续维护者误用 console.log，也重定向到 stderr，保证 stdout 纯净。
console.log = (...args: unknown[]): void => {
  console.error(...args);
};

async function main(): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerListSessions(server);
  registerGetSession(server);
  registerSearchTranscripts(server);
  registerSearchCards(server);
  registerGetCard(server);
  registerGetSessionLedger(server);
  registerSearchVault(server);
  registerGetVaultEntry(server);
  registerGetVaultVersion(server);

  const shutdown = (signal: string): void => {
    console.error(`[cuemind-mcp] received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  console.error(`[cuemind-mcp] ready (name=${SERVER_NAME}, version=${SERVER_VERSION}, stdio, read-only)`);
}

main().catch((error: unknown) => {
  console.error("[cuemind-mcp] fatal:", error);
  process.exit(1);
});
