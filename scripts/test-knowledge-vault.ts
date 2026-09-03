// Phase C 回归：知识条目 vault 导出 + 冲突检测。
// 覆盖：新导出、幂等重导出、应用侧更新后覆盖、外部编辑 → 409 冲突（文件不被改写）、
// force 显式覆盖、会话鉴权（401/404）、归档条目拒绝导出、vault 路径由服务端解析。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { POST as knowledgePost, GET as knowledgeGet } from "@/app/api/knowledge/route";
import { POST as exportPost } from "@/app/api/knowledge/[id]/export/route";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-knowledge-vault-"));
process.env.CUEMIND_VAULT_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-knowledge-vault-dir-"));
process.env.CUEMIND_SESSION_STORE = "jsonl";
process.env.CUEMIND_KNOWLEDGE_STORE = "jsonl";

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

async function main(): Promise<void> {
  // --- 引导两个会话（A 持有条目，B 用于跨会话拒绝断言） ---
  const sessionA = await sessionsPost(request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "vault-a", title: "Vault A", transcriptChunks: [] }) }));
  assert.equal(sessionA.status, 200);
  const { sessionAccessToken: tokenA } = await sessionA.json() as { sessionAccessToken: string };
  const headersA = { "content-type": "application/json", "X-Session-Id": "vault-a", "X-Session-Token": tokenA };

  const sessionB = await sessionsPost(request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "vault-b", title: "Vault B", transcriptChunks: [] }) }));
  assert.equal(sessionB.status, 200);
  const { sessionAccessToken: tokenB } = await sessionB.json() as { sessionAccessToken: string };
  const headersB = { "content-type": "application/json", "X-Session-Id": "vault-b", "X-Session-Token": tokenB };

  // --- 创建条目 ---
  const created = await knowledgePost(request("/api/knowledge", { method: "POST", headers: headersA, body: JSON.stringify({ sessionId: "vault-a", title: "KV Cache", content: "缓存机制说明", summary: "摘要" }) }));
  assert.equal(created.status, 201);
  const entry = (await created.json() as { entry: { id: string; version: number; vaultFile: string | null } }).entry;
  assert.equal(entry.vaultFile, null);

  const exportUrl = `/api/knowledge/${entry.id}/export`;
  const exportBody = JSON.stringify({ sessionId: "vault-a" });
  const exportContext = { params: Promise.resolve({ id: entry.id }) };

  // --- 鉴权：缺 token 401；跨会话 404 ---
  assert.equal((await exportPost(request(exportUrl, { method: "POST", headers: { "content-type": "application/json" }, body: exportBody }), exportContext)).status, 401);
  assert.equal((await exportPost(request(exportUrl, { method: "POST", headers: headersB, body: JSON.stringify({ sessionId: "vault-b" }) }), exportContext)).status, 404);

  // --- 首次导出：saved，文件落盘且 frontmatter 带 entry_id ---
  const first = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: exportBody }), exportContext);
  assert.equal(first.status, 200);
  const firstPayload = await first.json() as { saved: boolean; file: string; entry: { vaultFile: string | null; vaultFileHash: string | null; vaultExportedVersion: number | null; vaultConflict: boolean } };
  assert.equal(firstPayload.saved, true);
  assert.equal(firstPayload.entry.vaultExportedVersion, 1);
  assert.equal(firstPayload.entry.vaultConflict, false);
  const vaultFilePath = path.join(process.env.CUEMIND_VAULT_DIR as string, firstPayload.file.replaceAll("/", path.sep));
  const firstContent = readFileSync(vaultFilePath, "utf8");
  assert.match(firstContent, /entry_id: ".*"/);
  assert.match(firstContent, /exported_version: 1/);
  assert.ok(firstContent.includes("# KV Cache"));

  // --- 幂等重导出：unchanged，文件内容不变 ---
  const second = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: exportBody }), exportContext);
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { skipped?: string }).skipped, "unchanged");
  assert.equal(readFileSync(vaultFilePath, "utf8"), firstContent, "幂等重导出不应改写文件");

  // --- 应用侧更新（PATCH → version 2）→ 导出写新修订 ---
  const { PATCH } = await import("@/app/api/knowledge/route");
  const patch = await PATCH(request(`/api/knowledge/${entry.id}`, { method: "PATCH", headers: headersA, body: JSON.stringify({ sessionId: "vault-a", version: 1, content: "更新后的内容" }) }));
  assert.equal(patch.status, 200);
  const revised = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: exportBody }), exportContext);
  assert.equal(revised.status, 200);
  const revisedPayload = await revised.json() as { saved: boolean; entry: { vaultExportedVersion: number | null } };
  assert.equal(revisedPayload.saved, true);
  assert.equal(revisedPayload.entry.vaultExportedVersion, 2);
  assert.notEqual(readFileSync(vaultFilePath, "utf8"), firstContent, "应用侧更新后应写新修订");

  // --- 外部编辑 → 409 冲突，文件不被改写，entry 标记 vaultConflict ---
  const externalContent = "# 用户手改\n\n外部编辑内容\n";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(vaultFilePath, externalContent, "utf8");
  const conflict = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: exportBody }), exportContext);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { conflict: boolean }).conflict, true);
  assert.equal(readFileSync(vaultFilePath, "utf8"), externalContent, "冲突时绝不改写外部编辑的文件");
  const conflictedDetail = await knowledgeGet(request(`/api/knowledge/${entry.id}?sessionId=vault-a`, { headers: headersA }));
  assert.equal((await conflictedDetail.json() as { entry: { vaultConflict: boolean } }).entry.vaultConflict, true);

  // --- force 显式覆盖 → saved，冲突清除，文件回到应用内容 ---
  const forced = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: JSON.stringify({ sessionId: "vault-a", force: true }) }), exportContext);
  assert.equal(forced.status, 200);
  const forcedPayload = await forced.json() as { saved: boolean; entry: { vaultConflict: boolean } };
  assert.equal(forcedPayload.saved, true);
  assert.equal(forcedPayload.entry.vaultConflict, false);
  assert.notEqual(readFileSync(vaultFilePath, "utf8"), externalContent);

  // --- 归档条目拒绝导出（当前版本仍为 2）---
  await PATCH(request(`/api/knowledge/${entry.id}`, { method: "PATCH", headers: headersA, body: JSON.stringify({ sessionId: "vault-a", version: 2, status: "archived" }) }));
  const archivedExport = await exportPost(request(exportUrl, { method: "POST", headers: headersA, body: exportBody }), exportContext);
  assert.equal(archivedExport.status, 400);

  console.log("test-knowledge-vault: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
