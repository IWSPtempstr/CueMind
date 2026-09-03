// Phase C：知识条目 vault 导出。POST /api/knowledge/<id>/export
// body: { sessionId, force? } → { entry }（含更新后的 vault 元数据）
// 或 409 { conflict: true, file, error }（检测到外部编辑，未改写文件）。
// vault 根路径完全由服务端解析（resolveVaultRoot 无请求参数），HTTP 输入无法穿越。

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit, readJsonBodyWithLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { getKnowledgeStore } from "@/lib/knowledge-store";
import { exportKnowledgeToVault } from "@/lib/knowledge-vault";
import { canLeaveLocalBoundary, redactCopy } from "@/lib/privacy";
import { resolveVaultRoot } from "@/lib/vault-exporter";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_000;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "knowledge-export", 30);
  if (limited) return limited;

  const parsedBody = await readJsonBodyWithLimit(request, MAX_BODY_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body: unknown = parsedBody.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const denied = requireSessionAccess(request, sessionId);
  if (denied) return denied;

  const { id } = await context.params;
  const store = getKnowledgeStore();
  const entry = store.get(id.trim());
  if (!entry || !entry.originSessionIds.includes(sessionId) || entry.status === "deleted") {
    return NextResponse.json({ error: "Knowledge entry not found" }, { status: 404 });
  }

  // 归档条目只读不导出：vault 是对外可读表示，archive 语义即「退出活跃沉淀」。
  if (entry.status === "archived") {
    return NextResponse.json({ error: "Archived entries cannot be exported" }, { status: 400 });
  }

  // Phase D：隐私门控。blocked / privacy_uncertain 均不允许离开本地边界；
  // privacy_uncertain 需先经 PATCH privacy 人工复审（redacted/clear）再导出。
  if (!canLeaveLocalBoundary(entry.privacy)) {
    return NextResponse.json(
      {
        error: entry.privacy === "blocked"
          ? "Entry is privacy-blocked and cannot leave the local boundary"
          : "Entry privacy is uncertain; review it (PATCH privacy: redacted|clear) before exporting",
        privacy: entry.privacy,
        reasons: entry.privacyReasons,
      },
      { status: 403 },
    );
  }

  // redacted：导出副本脱敏（EMAIL/PHONE/SECRET + aliases 作 PERSON 字典），
  // 库内原文与不可变会话记录不动。
  const exportSource = entry.privacy === "redacted"
    ? (() => {
        const copy = redactCopy(entry.title, entry.summary, entry.content, entry.aliases);
        return { ...entry, title: copy.title, summary: copy.summary, content: copy.content };
      })()
    : entry;

  const { result, next } = exportKnowledgeToVault(resolveVaultRoot(), exportSource, {
    force: record.force === true,
  });
  // store 回写始终以真实 entry 为基底（exportSource 可能是脱敏副本，绝不入库覆盖原文）。
  const storeNext: typeof entry = entry.privacy === "redacted"
    ? { ...entry, vaultFile: next.vaultFile, vaultFileHash: next.vaultFileHash, vaultExportedVersion: next.vaultExportedVersion, vaultExportedAt: next.vaultExportedAt, vaultConflict: next.vaultConflict }
    : next;
  if (result.outcome === "conflict") {
    store.upsert(storeNext);
    return NextResponse.json(
      { conflict: true, file: result.file, error: "Vault file was edited outside CueMind; review and re-export with force to overwrite" },
      { status: 409 },
    );
  }
  store.upsert(storeNext);
  if (result.outcome === "skipped") {
    return NextResponse.json({ entry: storeNext, skipped: result.reason });
  }
  return NextResponse.json({ entry: storeNext, saved: true, file: result.file });
}
