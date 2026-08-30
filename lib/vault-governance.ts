import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SOURCE_LEVELS = ["primary", "official", "academic", "community", "unknown"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];
export type VaultEntryStatus = "active" | "pending_review" | "needs_review" | "withdrawn" | "superseded";

export interface VaultVersion {
  version: number;
  title: string;
  body: string;
  sourceUrl: string;
  sourceLevel: SourceLevel;
  status: VaultEntryStatus;
  updatedAt: string;
  auditId: string;
}

export interface VaultEntry {
  entryId: string;
  currentVersion: number | null;
  conflictIds: string[];
  versions: VaultVersion[];
  audit: Array<{ auditId: string; action: string; actor: string; at: string; version: number | null; detail?: string }>;
}

interface Store { entries: Record<string, VaultEntry> }
export interface CreateVaultEntryInput {
  entryId: string; title: string; body: string; sourceUrl: string; sourceType?: string;
  sourceLevel?: SourceLevel; highRisk?: boolean; conflictId?: string; actor: string;
}

const FILE = ".cuemind-governance.json";

function storePath(root: string): string { return path.join(root, FILE); }
function load(root: string): Store {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(root), "utf8"));
    if (parsed && typeof parsed === "object" && "entries" in parsed) return parsed as Store;
  } catch { /* missing/corrupt store starts empty; audit is recreated on next write */ }
  return { entries: {} };
}
function save(root: string, store: Store): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(storePath(root), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
function level(input: CreateVaultEntryInput): SourceLevel {
  if (input.sourceLevel && SOURCE_LEVELS.includes(input.sourceLevel)) return input.sourceLevel;
  const type = (input.sourceType ?? "").toLowerCase();
  if (type === "primary" || type === "official" || type === "academic" || type === "community") return type;
  return "unknown";
}
function auditId(entryId: string, version: number, body: string): string {
  return createHash("sha256").update(`${entryId}\0${version}\0${body}`).digest("hex").slice(0, 16);
}

export function createVaultEntry(root: string, input: CreateVaultEntryInput): VaultVersion {
  if (!input.entryId.trim() || !input.title.trim() || !input.body.trim()) throw new Error("entryId, title and body are required");
  const store = load(root);
  const entry = store.entries[input.entryId] ?? { entryId: input.entryId, currentVersion: null, conflictIds: [], versions: [], audit: [] };
  const version = entry.versions.length + 1;
  const status: VaultEntryStatus = entry.currentVersion === null || (!input.highRisk && !input.conflictId) ? "active" : (input.conflictId ? "needs_review" : "pending_review");
  const now = new Date().toISOString();
  const item: VaultVersion = { version, title: input.title, body: input.body, sourceUrl: input.sourceUrl, sourceLevel: level(input), status, updatedAt: now, auditId: auditId(input.entryId, version, input.body) };
  entry.versions.push(item);
  if (input.conflictId && !entry.conflictIds.includes(input.conflictId)) entry.conflictIds.push(input.conflictId);
  if (status === "active") {
    if (entry.currentVersion !== null) entry.versions.find((v) => v.version === entry.currentVersion)!.status = "superseded";
    entry.currentVersion = version;
  }
  entry.audit.push({ auditId: item.auditId, action: "create", actor: input.actor, at: now, version, detail: input.conflictId ?? (input.highRisk ? "high-risk" : undefined) });
  store.entries[input.entryId] = entry;
  save(root, store);
  return item;
}

export function approveVaultEntry(root: string, entryId: string, version: number, actor: string): VaultVersion {
  const store = load(root); const entry = store.entries[entryId];
  if (!entry) throw new Error(`Vault entry not found: ${entryId}`);
  const item = entry.versions.find((v) => v.version === version);
  if (!item) throw new Error(`Vault version not found: ${entryId}@${version}`);
  if (entry.currentVersion !== null && entry.currentVersion !== version) entry.versions.find((v) => v.version === entry.currentVersion)!.status = "superseded";
  item.status = "active"; entry.currentVersion = version;
  const now = new Date().toISOString(); entry.audit.push({ auditId: item.auditId, action: "approve", actor, at: now, version }); save(root, store); return item;
}

export function withdrawVaultEntry(root: string, entryId: string, actor: string): VaultVersion {
  const store = load(root); const entry = store.entries[entryId];
  if (!entry || entry.currentVersion === null) throw new Error(`Active Vault entry not found: ${entryId}`);
  const item = entry.versions.find((v) => v.version === entry.currentVersion)!; item.status = "withdrawn"; entry.currentVersion = null;
  const now = new Date().toISOString(); entry.audit.push({ auditId: item.auditId, action: "withdraw", actor, at: now, version: item.version }); save(root, store); return item;
}

export function getVaultEntry(root: string, entryId: string): VaultEntry | null { return load(root).entries[entryId] ?? null; }
export function getVaultVersion(root: string, entryId: string, version: number): VaultVersion | null { return getVaultEntry(root, entryId)?.versions.find((v) => v.version === version) ?? null; }
export function searchVaultEntries(root: string, query: string): VaultEntry[] {
  const needle = query.trim().toLowerCase(); if (!needle) return [];
  return Object.values(load(root).entries).filter((entry) => {
    if (entry.currentVersion === null) return false;
    const version = entry.versions.find((v) => v.version === entry.currentVersion);
    return version?.status === "active" && `${version.title}\n${version.body}\n${version.sourceUrl}`.toLowerCase().includes(needle);
  });
}
