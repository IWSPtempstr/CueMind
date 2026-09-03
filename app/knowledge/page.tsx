"use client";

// Phase B：/knowledge 知识库管理页（独立于会议主界面，管理面不耦合会议状态）。
// 三栏布局：左侧搜索/筛选，中间条目列表，右侧详情/编辑。
// 所有请求沿用客户端会话令牌模式（X-Session-Token，lib/client-session-auth），
// 服务端按 sessionId 做 session 作用域隔离；401 时提示切换会话。

import { useCallback, useEffect, useState, type ReactElement } from "react";
import Link from "next/link";
import {
  loadLastActiveSessionId,
  loadSessionAccessToken,
  withSessionHeaders,
} from "@/lib/client-session-auth";

type KnowledgeStatus = "active" | "archived" | "deleted";

interface KnowledgeEntry {
  id: string;
  slug: string;
  title: string;
  aliases: string[];
  summary: string;
  content: string;
  sourceTypes: string[];
  sourceUrls: string[];
  originSessionIds: string[];
  originCardIds: string[];
  status: KnowledgeStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  version: number;
  // Phase C：vault 同步元数据（与 lib/knowledge-store 保持同形）。
  vaultFile: string | null;
  vaultFileHash: string | null;
  vaultExportedVersion: number | null;
  vaultExportedAt: string | null;
  vaultConflict: boolean;
}

export default function KnowledgePage(): ReactElement {
  const [sessionId, setSessionId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [draft, setDraft] = useState({ title: "", aliases: "", summary: "", content: "" });
  const [conflict, setConflict] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // 会话引导：URL ?sessionId= 优先，其次主界面写入的最近会话。
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("sessionId")?.trim() ?? "";
    setSessionId(fromUrl || loadLastActiveSessionId());
  }, []);

  // 搜索防抖：300ms 静默后才发起请求。
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const token = sessionId ? loadSessionAccessToken(sessionId) : "";
  const hasAuth = sessionId !== "" && token !== "";

  const loadList = useCallback(async (): Promise<void> => {
    if (!hasAuth) return;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sessionId, status: statusFilter });
      if (query) params.set("q", query);
      const response = await fetch(`/api/knowledge?${params.toString()}`, { headers: withSessionHeaders(sessionId) });
      if (!response.ok) {
        setError(response.status === 401 ? "会话令牌无效或缺失，无法访问该会话的知识库。" : `加载知识库失败（HTTP ${response.status}）`);
        setEntries([]);
        return;
      }
      const payload: unknown = await response.json();
      const list = typeof payload === "object" && payload !== null && Array.isArray((payload as { entries?: unknown }).entries)
        ? (payload as { entries: KnowledgeEntry[] }).entries
        : [];
      setEntries(list);
    } catch {
      setError("加载知识库失败：网络错误");
    } finally {
      setIsLoading(false);
    }
  }, [hasAuth, query, sessionId, statusFilter]);

  useEffect(() => {
    setSelectedId(null);
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setConflict(false);
    setVaultNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`, { headers: withSessionHeaders(sessionId) });
      if (!response.ok) {
        setError(response.status === 404 ? "条目不存在或已被删除。" : `加载条目失败（HTTP ${response.status}）`);
        setSelected(null);
        return;
      }
      const payload: unknown = await response.json();
      const entry = typeof payload === "object" && payload !== null ? (payload as { entry?: KnowledgeEntry }).entry ?? null : null;
      if (!entry) {
        setSelected(null);
        return;
      }
      setSelected(entry);
      setDraft({
        title: entry.title,
        aliases: entry.aliases.join(", "),
        summary: entry.summary,
        content: entry.content,
      });
    } catch {
      setError("加载条目失败：网络错误");
    }
  }, [sessionId]);

  useEffect(() => {
    if (selectedId === null) {
      setSelected(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  // Phase C：导出到 vault。409 = 检测到外部编辑（服务端未改写文件）；
  // force=true 仅在用户看到冲突提示后显式点击「覆盖导出」时发送。
  const handleExport = async (force: boolean): Promise<void> => {
    if (!selected) return;
    setIsExporting(true);
    setVaultNotice(null);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(selected.id)}/export`, {
        method: "POST",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId, force }),
      });
      if (response.status === 409) {
        const payload: unknown = await response.json().catch(() => null);
        const file = typeof payload === "object" && payload !== null ? (payload as { file?: unknown }).file : null;
        setVaultNotice(`vault 文件在 CueMind 之外被修改过${typeof file === "string" ? `（${file}）` : ""}，已停止自动导出。确认要丢弃外部修改并覆盖，请点击「覆盖导出」。`);
        setSelected((previous) => (previous ? { ...previous, vaultConflict: true } : previous));
        return;
      }
      if (!response.ok) {
        setError(response.status === 401 ? "会话令牌无效，无法导出。" : `导出失败（HTTP ${response.status}）`);
        return;
      }
      const payload: unknown = await response.json();
      const entry = typeof payload === "object" && payload !== null ? (payload as { entry?: KnowledgeEntry }).entry : undefined;
      if (entry) setSelected(entry);
      const skipped = typeof payload === "object" && payload !== null && (payload as { skipped?: unknown }).skipped === "unchanged";
      setVaultNotice(skipped ? "vault 文件已是最新，无需重写。" : "已导出到 vault。");
      void loadList();
    } catch {
      setError("导出失败：网络错误");
    } finally {
      setIsExporting(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!selected) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId,
          version: selected.version,
          title: draft.title,
          aliases: draft.aliases.split(/[,，]/).map((alias) => alias.trim()).filter(Boolean),
          summary: draft.summary,
          content: draft.content,
        }),
      });
      if (response.status === 409) {
        setConflict(true);
        return;
      }
      if (!response.ok) {
        setError(`保存失败（HTTP ${response.status}）`);
        return;
      }
      const payload: unknown = await response.json();
      const entry = typeof payload === "object" && payload !== null ? (payload as { entry?: KnowledgeEntry }).entry : undefined;
      if (entry) {
        setSelected(entry);
        setDraft({ title: entry.title, aliases: entry.aliases.join(", "), summary: entry.summary, content: entry.content });
      }
      void loadList();
    } catch {
      setError("保存失败：网络错误");
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusChange = async (status: "active" | "archived"): Promise<void> => {
    if (!selected) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: withSessionHeaders(sessionId, { "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId, version: selected.version, status }),
      });
      if (response.status === 409) {
        setConflict(true);
        return;
      }
      if (!response.ok) {
        setError(`操作失败（HTTP ${response.status}）`);
        return;
      }
      setSelectedId(null);
      void loadList();
    } catch {
      setError("操作失败：网络错误");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`确定删除「${selected.title}」？（软删除）`)) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(selected.id)}?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: withSessionHeaders(sessionId),
      });
      if (!response.ok) {
        setError(`删除失败（HTTP ${response.status}）`);
        return;
      }
      setSelectedId(null);
      void loadList();
    } catch {
      setError("删除失败：网络错误");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-dvh min-h-0 w-full flex-col bg-[#0a0a0a] text-neutral-200">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-950 px-4 py-1">
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200">← 返回会议</Link>
          <span className="text-sm font-medium uppercase tracking-widest text-neutral-400">知识库管理</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          会话 ID
          <input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value.trim())}
            placeholder="粘贴会话 ID"
            aria-label="Session ID"
            className="w-72 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-300"
          />
        </label>
      </header>
      {!hasAuth ? (
        <div className="border-b border-amber-900 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
          请先在主界面开启会话后进入本页（需要该会话的访问令牌），或在右上角粘贴会话 ID。
        </div>
      ) : null}
      {error ? <div className="border-b border-red-900 bg-red-950/30 px-4 py-2 text-xs text-red-300">{error}</div> : null}
      <main className="flex min-h-0 w-full flex-1">
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r border-neutral-800 p-4">
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder="搜索标题 / 别名 / 摘要 / 内容"
            aria-label="Search knowledge"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200"
          />
          <div className="flex gap-1" role="group" aria-label="Status filter">
            {(["active", "archived"] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`flex-1 rounded border px-2 py-1 text-xs ${statusFilter === status ? "border-blue-700 bg-blue-950 text-blue-200" : "border-neutral-700 text-neutral-400"}`}
              >
                {status === "active" ? "进行中" : "已归档"}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-neutral-600">知识条目按会话隔离；仅显示当前会话可访问的内容。</p>
        </aside>
        <section className="flex w-80 shrink-0 flex-col border-r border-neutral-800">
          <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-3">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500">{statusFilter === "active" ? "进行中的知识条目" : "已归档条目"}</h2>
            <span className="text-[10px] text-neutral-500">{entries.length} 条</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? <p className="p-4 text-xs text-blue-300">加载中…</p> : null}
            {!isLoading && entries.length === 0 ? <p className="p-4 text-xs text-neutral-600">{query ? "无匹配条目。" : "暂无条目。可在会议中把上下文卡片存入知识库。"}</p> : null}
            <ul>
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(entry.id)}
                    className={`w-full border-b border-neutral-900 px-4 py-3 text-left transition-colors hover:bg-neutral-900 ${selectedId === entry.id ? "bg-neutral-900" : ""}`}
                  >
                    <span className="block truncate text-sm text-neutral-200">{entry.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{entry.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section className="min-w-0 flex-1 overflow-y-auto p-5">
          {!selected ? (
            <p className="text-sm text-neutral-600">从中间列表选择一个条目查看与编辑。</p>
          ) : (
            <div className="flex max-w-3xl flex-col gap-4">
              {conflict ? (
                <div className="flex items-center justify-between rounded border border-amber-700 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
                  <span>保存冲突：该条目已被其他窗口修改（版本不一致）。</span>
                  <button
                    type="button"
                    onClick={() => { setConflict(false); void loadDetail(selected.id); }}
                    className="rounded border border-amber-600 px-2 py-0.5 text-amber-200"
                  >
                    重新加载
                  </button>
                </div>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold text-neutral-100">{selected.title}</p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    版本 {selected.version} · 更新于 {new Date(selected.updatedAt).toLocaleString()} ·
                    {" "}{selected.status === "archived" ? "已归档" : "进行中"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    vault：{selected.vaultConflict
                      ? <span className="text-amber-400">⚠ 冲突（文件被外部修改）</span>
                      : selected.vaultFile
                        ? `已导出 v${selected.vaultExportedVersion ?? "?"} · ${selected.vaultFile}`
                        : "未导出"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {selected.status === "active" ? (
                    <button type="button" disabled={isSaving} onClick={() => handleStatusChange("archived")} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 disabled:opacity-50">归档</button>
                  ) : (
                    <button type="button" disabled={isSaving} onClick={() => handleStatusChange("active")} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 disabled:opacity-50">恢复</button>
                  )}
                  {selected.status === "active" ? (
                    selected.vaultConflict ? (
                      <button type="button" disabled={isExporting} onClick={() => handleExport(true)} className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-300 disabled:opacity-50">
                        {isExporting ? "覆盖中…" : "⚠ 覆盖导出"}
                      </button>
                    ) : (
                      <button type="button" disabled={isExporting} onClick={() => handleExport(false)} className="rounded border border-emerald-800 px-2 py-1 text-xs text-emerald-300 disabled:opacity-50">
                        {isExporting ? "导出中…" : "导出到 vault"}
                      </button>
                    )
                  ) : null}
                  <button type="button" disabled={isSaving} onClick={handleDelete} className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 disabled:opacity-50">删除</button>
                </div>
              </div>
              {vaultNotice ? (
                <div className={`rounded border px-3 py-2 text-xs ${selected.vaultConflict ? "border-amber-700 bg-amber-950/40 text-amber-200" : "border-emerald-800 bg-emerald-950/30 text-emerald-200"}`}>
                  {vaultNotice}
                </div>
              ) : null}
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                标题
                <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                别名（逗号分隔）
                <input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                摘要
                <textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} rows={2} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                内容
                <textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} rows={10} className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm leading-relaxed text-neutral-100" />
              </label>
              <div className="flex items-center gap-2">
                <button type="button" disabled={isSaving || conflict} onClick={handleSave} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">
                  {isSaving ? "保存中…" : "保存"}
                </button>
                <button type="button" disabled={isSaving} onClick={() => { setConflict(false); setDraft({ title: selected.title, aliases: selected.aliases.join(", "), summary: selected.summary, content: selected.content }); }} className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 disabled:opacity-50">
                  放弃更改
                </button>
              </div>
              {selected.sourceUrls.length > 0 ? (
                <div className="border-t border-neutral-800 pt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">来源</p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {selected.sourceUrls.map((url) => (
                      <li key={url}>
                        <a href={url} target="_blank" rel="noreferrer" className="truncate text-xs text-blue-400 underline underline-offset-2">{url}</a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="border-t border-neutral-800 pt-3 text-[11px] text-neutral-600">
                <p>来源会话：{selected.originSessionIds.join("、") || "—"}</p>
                <p>来源卡片：{selected.originCardIds.join("、") || "—"}</p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
