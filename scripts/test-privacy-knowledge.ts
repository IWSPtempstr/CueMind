// Phase D 回归：知识条目隐私状态机（计划 §10）。
// 覆盖：SECRET → blocked（导出 403）；EMAIL → privacy_uncertain（导出 403 → 复审 redacted
// → 导出成功且文件为脱敏副本、库内原文不动）；clear 条目正常导出；内容编辑重新引入敏感
// 数据 → 重检测阻断；显式复审记录 privacyReviewedAt。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as sessionsPost } from "@/app/api/sessions/route";
import { POST as knowledgePost, GET as knowledgeGet, PATCH as knowledgePatch } from "@/app/api/knowledge/route";
import { POST as exportPost } from "@/app/api/knowledge/[id]/export/route";

process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-privacy-"));
process.env.CUEMIND_VAULT_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-privacy-vault-"));
process.env.CUEMIND_SESSION_STORE = "jsonl";
process.env.CUEMIND_KNOWLEDGE_STORE = "jsonl";

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

interface EntryPayload {
  entry: {
    id: string;
    version: number;
    content: string;
    privacy: string;
    privacyReasons: string[];
    privacyReviewedAt: string | null;
    vaultFile: string | null;
  };
}

async function main(): Promise<void> {
  const session = await sessionsPost(request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "privacy-a", title: "隐私测试", transcriptChunks: [] }) }));
  assert.equal(session.status, 200);
  const { sessionAccessToken } = await session.json() as { sessionAccessToken: string };
  const headers = { "content-type": "application/json", "X-Session-Id": "privacy-a", "X-Session-Token": sessionAccessToken };

  // --- SECRET → blocked，导出 403 且不落盘 ---
  const secret = await knowledgePost(request("/api/knowledge", { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a", title: "部署要点", content: "API key is sk-abcdefghijkmnopq", summary: "密钥" }) }));
  assert.equal(secret.status, 201);
  const secretEntry = (await secret.json() as EntryPayload).entry;
  assert.equal(secretEntry.privacy, "blocked");
  assert.deepEqual(secretEntry.privacyReasons, ["SECRET"]);
  const blockedExport = await exportPost(request(`/api/knowledge/${secretEntry.id}/export`, { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a" }) }), { params: Promise.resolve({ id: secretEntry.id }) });
  assert.equal(blockedExport.status, 403);
  assert.equal(secretEntry.vaultFile, null);

  // --- EMAIL → privacy_uncertain，导出 403；复审 redacted → 导出成功且文件脱敏、原文不动 ---
  const email = await knowledgePost(request("/api/knowledge", { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a", title: "联系人", content: "负责人 zhang.san@example.com 负责评审", summary: "联系人" }) }));
  assert.equal(email.status, 201);
  const emailEntry = (await email.json() as EntryPayload).entry;
  assert.equal(emailEntry.privacy, "privacy_uncertain");
  assert.deepEqual(emailEntry.privacyReasons, ["EMAIL"]);
  const uncertainExport = await exportPost(request(`/api/knowledge/${emailEntry.id}/export`, { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a" }) }), { params: Promise.resolve({ id: emailEntry.id }) });
  assert.equal(uncertainExport.status, 403);

  const reviewed = await knowledgePatch(request(`/api/knowledge/${emailEntry.id}`, { method: "PATCH", headers, body: JSON.stringify({ sessionId: "privacy-a", version: 1, privacy: "redacted" }) }));
  assert.equal(reviewed.status, 200);
  const reviewedEntry = (await reviewed.json() as EntryPayload).entry;
  assert.equal(reviewedEntry.privacy, "redacted");
  assert.ok(reviewedEntry.privacyReviewedAt !== null, "人工复审应记录 privacyReviewedAt");
  assert.equal(reviewedEntry.content, "负责人 zhang.san@example.com 负责评审", "复审不改库内原文");

  const redactedExport = await exportPost(request(`/api/knowledge/${emailEntry.id}/export`, { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a" }) }), { params: Promise.resolve({ id: emailEntry.id }) });
  assert.equal(redactedExport.status, 200);
  const redactedResult = await redactedExport.json() as { file: string; entry: { content: string } };
  assert.equal(redactedResult.entry.content, "负责人 zhang.san@example.com 负责评审", "导出后 store 原文不变");
  const vaultFile = readFileSync(path.join(process.env.CUEMIND_VAULT_DIR as string, redactedResult.file.replaceAll("/", path.sep)), "utf8");
  assert.ok(!vaultFile.includes("zhang.san@example.com"), "导出文件不得含原始邮箱");
  assert.match(vaultFile, /EMAIL_1/, "导出文件应为脱敏副本");
  assert.match(vaultFile, /privacy: redacted/);

  // --- clear 条目正常导出 ---
  const plain = await knowledgePost(request("/api/knowledge", { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a", title: "KV Cache", content: "缓存机制", summary: "摘要" }) }));
  const plainEntry = (await plain.json() as EntryPayload).entry;
  assert.equal(plainEntry.privacy, "clear");
  const plainExport = await exportPost(request(`/api/knowledge/${plainEntry.id}/export`, { method: "POST", headers, body: JSON.stringify({ sessionId: "privacy-a" }) }), { params: Promise.resolve({ id: plainEntry.id }) });
  assert.equal(plainExport.status, 200);

  // --- 内容编辑重新引入 SECRET → 重检测 blocked（即使此前已复审 clear） ---
  const edited = await knowledgePatch(request(`/api/knowledge/${plainEntry.id}`, { method: "PATCH", headers, body: JSON.stringify({ sessionId: "privacy-a", version: 1, content: "token: api-1234567890abcd" }) }));
  assert.equal(edited.status, 200);
  const editedEntry = (await edited.json() as EntryPayload).entry;
  assert.equal(editedEntry.privacy, "blocked", "编辑引入 SECRET 应重新阻断");

  // --- 库内明细仍可读（本地保存不被隐私状态阻断），隐私状态随明细返回 ---
  const detail = await knowledgeGet(request(`/api/knowledge/${secretEntry.id}?sessionId=privacy-a`, { headers }));
  assert.equal((await detail.json() as EntryPayload).entry.privacy, "blocked");

  console.log("test-privacy-knowledge: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
