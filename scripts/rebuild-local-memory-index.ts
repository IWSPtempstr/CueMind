import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveVaultRoot } from "@/lib/vault-exporter";
import { getKnowledgeMemoryStore, resetKnowledgeMemoryStoreForTests } from "@/lib/knowledge-memory-store";
import { slugifyTerm } from "@/lib/vault-exporter";
import type { KnowledgeCardRecord } from "@/lib/knowledge-memory";

function frontmatterValue(raw: string, key: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return [];
  const line = match[1].split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}:`));
  if (!line) return [];
  const value = line.slice(key.length + 1).trim();
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  return value ? [value.replace(/^['\"]|['\"]$/g, "")] : [];
}

function parseConcept(filePath: string): KnowledgeCardRecord | null {
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); } catch { return null; }
  const title = raw.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (!title) return null;
  const aliases = frontmatterValue(raw, "aliases");
  const origins = frontmatterValue(raw, "origin_meetings");
  const updated = frontmatterValue(raw, "updated")[0] || new Date().toISOString();
  const sourceUrls = [...raw.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const keyPoints = body.split(/\r?\n/).map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim()).filter((point): point is string => Boolean(point));
  return {
    id: `concept:${slugifyTerm(title)}`,
    kind: "knowledge_card",
    keyword: title,
    aliases: aliases.length > 0 ? aliases : [title],
    explanation: keyPoints.join(" "),
    keyPoints,
    sourceUrls,
    originMeeting: origins[0] || "vault-rebuild",
    status: "active",
    validUntil: null,
    createdAt: updated,
    updatedAt: updated,
  };
}

function run(): void {
  const root = resolveVaultRoot(process.env.CUEMIND_VAULT_DIR);
  const conceptsDir = path.join(root, "cuemind", "concepts");
  if (!existsSync(conceptsDir)) {
    console.log(JSON.stringify({ indexed: 0, skipped: 0, reason: "concepts directory missing" }));
    return;
  }
  resetKnowledgeMemoryStoreForTests();
  const records = readdirSync(conceptsDir).filter((name) => name.endsWith(".md")).map((name) => parseConcept(path.join(conceptsDir, name))).filter((record): record is KnowledgeCardRecord => record !== null);
  const store = getKnowledgeMemoryStore();
  store.clear();
  store.upsert(records);
  console.log(JSON.stringify({ indexed: records.length, skipped: readdirSync(conceptsDir).length - records.length, backend: store.backend, vaultRoot: root }));
}

run();
