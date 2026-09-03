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

  const { result, next } = exportKnowledgeToVault(resolveVaultRoot(), entry, {
    force: record.force === true,
  });
  if (result.outcome === "conflict") {
    store.upsert(next);
    return NextResponse.json(
      { conflict: true, file: result.file, error: "Vault file was edited outside CueMind; review and re-export with force to overwrite" },
      { status: 409 },
    );
  }
  store.upsert(next);
  if (result.outcome === "skipped") {
    return NextResponse.json({ entry: next, skipped: result.reason });
  }
  return NextResponse.json({ entry: next, saved: true, file: result.file });
}
