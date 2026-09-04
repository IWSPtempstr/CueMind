import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { requireSessionAccess } from "@/lib/session-route";
import { getCandidate } from "@/lib/candidate-store";
import { getKnowledgeStore, type KnowledgeEntry, type KnowledgeStatus } from "@/lib/knowledge-store";
import { assessPrivacy, isPrivacyState } from "@/lib/privacy";
import { slugifyTerm } from "@/lib/vault-exporter";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 128_000;
const MAX_FIELD_CHARS = 8_000;
const MAX_TITLE_CHARS = 200;
const MAX_ALIASES = 20;
const MAX_SOURCES = 50;
const MAX_SOURCE_CHARS = 2_000;

function text(value: unknown, max = MAX_FIELD_CHARS): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;
}
function strings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, maxItems).map((item) => item.trim().slice(0, maxChars));
}
function sessionIdFrom(request: Request, body?: Record<string, unknown>): string {
  return text(body?.sessionId, 200) ?? request.headers.get("x-session-id")?.trim() ?? "";
}
function responseEntry(entry: KnowledgeEntry): KnowledgeEntry { return entry; }

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function belongs(entry: KnowledgeEntry, sessionId: string): boolean {
  return entry.originSessionIds.includes(sessionId);
}

// context.params 用 { id?: string }：同一 handler 同时被静态 /api/knowledge（validator 生成
// Promise<{}>）与动态 /api/knowledge/[id]（Promise<{ id: string }>）两条路径复用。
type KnowledgeRouteContext = { params: Promise<{ id?: string }> };

// 无 context 或无 params（Next 15 对静态 /api/knowledge 路由传 context={}，params 可能
// 为 undefined；测试直调时甚至可能缺 context）→ 从 pathname 解析 id。
function resolveId(context: KnowledgeRouteContext | undefined, request: Request): Promise<string> {
  if (context && context.params) return context.params.then((params) => (params.id ?? "").trim());
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = segments.indexOf("knowledge");
  return Promise.resolve(index >= 0 ? (segments[index + 1] ?? "").trim() : "");
}

export async function GET(request: Request, context?: KnowledgeRouteContext): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "knowledge", 60);
  if (limited) return limited;
  const id = await resolveId(context, request);
  const sessionId = request.headers.get("x-session-id")?.trim() || new URL(request.url).searchParams.get("sessionId")?.trim() || "";
  const denied = requireSessionAccess(request, sessionId);
  if (denied) return denied;
  const store = getKnowledgeStore();
  if (id) {
    const entry = store.get(id);
    return !entry || !belongs(entry, sessionId) || entry.status === "deleted"
      ? NextResponse.json({ error: "Knowledge entry not found" }, { status: 404 })
      : NextResponse.json({ entry: responseEntry(entry) });
  }
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  // Phase B：归档条目管理需要列表可见。默认 active；archived 只看归档；all 两者。
  const statusFilter = params.get("status") === "archived" ? "archived" : params.get("status") === "all" ? "all" : "active";
  const entries = query
    ? store.search(query, sessionId).flatMap((hit) => hit.entry.status !== "deleted" && (statusFilter === "all" || hit.entry.status === statusFilter) ? [{ ...responseEntry(hit.entry), score: hit.score }] : [])
    : store.list(sessionId).filter((entry) => entry.status !== "deleted" && (statusFilter === "all" || entry.status === statusFilter)).map((entry) => responseEntry(entry));
  return NextResponse.json({ entries });
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "knowledge", 30);
  if (limited) return limited;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid or oversized JSON body" }, { status: 413 });
  const sessionId = sessionIdFrom(request, body);
  const denied = requireSessionAccess(request, sessionId);
  if (denied) return denied;
  const title = text(body.title, MAX_TITLE_CHARS);
  const content = text(body.content);
  if (!title || !content) return NextResponse.json({ error: "title and content are required" }, { status: 400 });
  const now = new Date().toISOString();
  const summary = text(body.summary, MAX_FIELD_CHARS) ?? content.slice(0, 200);
  // Phase D：入站隐私检测（SECRET → blocked；EMAIL/PHONE → privacy_uncertain）。
  const assessment = assessPrivacy(title, summary, content);
  const entry: KnowledgeEntry = {
    id: text(body.id, 200) ?? `knowledge-${randomUUID()}`,
    slug: slugifyTerm(title), title, aliases: strings(body.aliases, MAX_ALIASES, MAX_TITLE_CHARS),
    summary, content,
    sourceTypes: strings(body.sourceTypes, MAX_SOURCES, MAX_SOURCE_CHARS), sourceUrls: strings(body.sourceUrls, MAX_SOURCES, MAX_SOURCE_CHARS),
    originSessionIds: [sessionId], originCardIds: strings(body.originCardIds, MAX_SOURCES, 200), status: "active",
    createdAt: now, updatedAt: now, lastUsedAt: null, version: 1,
    vaultFile: null, vaultFileHash: null, vaultExportedVersion: null, vaultExportedAt: null, vaultConflict: false,
    privacy: assessment.state, privacyReasons: assessment.reasons, privacyReviewedAt: null,
  };
  if (body.cardId !== undefined) {
    const cardId = text(body.cardId, 200);
    const candidate = cardId ? getCandidate(cardId) : null;
    if (!candidate || candidate.sessionId !== sessionId) return NextResponse.json({ error: "cardId does not belong to session" }, { status: 403 });
    entry.originCardIds = [...new Set([...entry.originCardIds, cardId as string])];
  }
  getKnowledgeStore().upsert(entry);
  return NextResponse.json({ entry }, { status: 201 });
}

export async function PATCH(request: Request, context?: KnowledgeRouteContext): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "knowledge", 30);
  if (limited) return limited;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid or oversized JSON body" }, { status: 413 });
  const sessionId = sessionIdFrom(request, body);
  const denied = requireSessionAccess(request, sessionId);
  if (denied) return denied;
  const id = await resolveId(context, request);
  const entry = getKnowledgeStore().get(id);
  if (!entry || !belongs(entry, sessionId) || entry.status === "deleted") return NextResponse.json({ error: "Knowledge entry not found" }, { status: 404 });
  if (body.version !== entry.version) return NextResponse.json({ error: "Knowledge entry version conflict" }, { status: 409 });
  // Phase B：archive/restore 走同一乐观锁 PATCH（status 只允许 active/archived，
  // 删除仍走 DELETE 软删，避免误清）。
  const requestedStatus = body.status === "active" || body.status === "archived" ? (body.status as KnowledgeStatus) : entry.status;
  const nextTitle = text(body.title, MAX_TITLE_CHARS) ?? entry.title;
  const nextSummary = text(body.summary) ?? entry.summary;
  const nextContent = text(body.content) ?? entry.content;
  const nextAliases = body.aliases === undefined ? entry.aliases : strings(body.aliases, MAX_ALIASES, MAX_TITLE_CHARS);
  // Phase D：内容变更时重检测（SECRET 恒阻断）；privacy 字段为显式人工复审结果
  // （privacyReviewedAt 记录时间），但 blocked 只能被复审解除为 redacted/clear，
  // 不能由检测自动降级覆盖人工结论。
  const reassessed = assessPrivacy(nextTitle, nextSummary, nextContent);
  const contentChanged = nextTitle !== entry.title || nextSummary !== entry.summary || nextContent !== entry.content;
  let privacy = entry.privacy;
  let privacyReasons = entry.privacyReasons;
  let privacyReviewedAt = entry.privacyReviewedAt;
  if (isPrivacyState(body.privacy)) {
    privacy = body.privacy;
    privacyReasons = reassessed.reasons;
    privacyReviewedAt = new Date().toISOString();
  } else if (contentChanged) {
    if (reassessed.state === "blocked") {
      privacy = "blocked";
      privacyReasons = reassessed.reasons;
    } else if (entry.privacy === "clear" && reassessed.state !== "clear") {
      privacy = reassessed.state;
      privacyReasons = reassessed.reasons;
    }
  }
  const next: KnowledgeEntry = { ...entry, title: nextTitle, summary: nextSummary, content: nextContent, aliases: nextAliases, status: requestedStatus, updatedAt: new Date().toISOString(), version: entry.version + 1, privacy, privacyReasons, privacyReviewedAt };
  getKnowledgeStore().upsert(next);
  return NextResponse.json({ entry: next });
}

export async function DELETE(request: Request, context?: KnowledgeRouteContext): Promise<NextResponse> {
  const limited = enforceRateLimit(request, "knowledge", 30);
  if (limited) return limited;
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() || request.headers.get("x-session-id")?.trim() || "";
  const denied = requireSessionAccess(request, sessionId);
  if (denied) return denied;
  const id = await resolveId(context, request);
  const entry = getKnowledgeStore().get(id);
  if (!entry || !belongs(entry, sessionId) || entry.status === "deleted") return NextResponse.json({ error: "Knowledge entry not found" }, { status: 404 });
  const next = { ...entry, status: "deleted" as KnowledgeStatus, updatedAt: new Date().toISOString(), version: entry.version + 1 };
  getKnowledgeStore().upsert(next);
  return NextResponse.json({ deleted: true });
}
