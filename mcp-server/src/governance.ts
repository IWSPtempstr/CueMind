import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./db.js";

export interface GovernanceVersion { version: number; title: string; body: string; sourceUrl: string; sourceLevel: string; status: string; updatedAt: string; auditId: string }
export interface GovernanceEntry { entryId: string; currentVersion: number | null; conflictIds: string[]; versions: GovernanceVersion[]; audit: unknown[] }

function root(): string { return process.env.CUEMIND_VAULT_DIR?.trim() ? path.resolve(process.env.CUEMIND_VAULT_DIR) : path.join(resolveDataDir(), "vault"); }
function entries(): Record<string, GovernanceEntry> {
  const file = path.join(root(), ".cuemind-governance.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, GovernanceEntry> };
    return parsed.entries ?? {};
  } catch { return {}; }
}
export function searchGovernance(query: string): GovernanceEntry[] {
  const needle = query.trim().toLowerCase(); if (!needle) return [];
  return Object.values(entries()).filter((entry) => {
    if (entry.currentVersion === null) return false;
    const v = entry.versions.find((item) => item.version === entry.currentVersion);
    return v?.status === "active" && `${v.title}\n${v.body}\n${v.sourceUrl}`.toLowerCase().includes(needle);
  });
}
export function getGovernanceEntry(entryId: string): GovernanceEntry | null { return entries()[entryId] ?? null; }
export function getGovernanceVersion(entryId: string, version: number): GovernanceVersion | null { return getGovernanceEntry(entryId)?.versions.find((v) => v.version === version) ?? null; }
