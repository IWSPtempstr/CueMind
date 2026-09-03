// Phase C：知识条目 → markdown vault 同步（冲突感知）。
//
// 目录契约（沿用 M3-a 布局）：
//   <vaultRoot>/cuemind/knowledge/<slug>.md — 可被 CueMind 重新导出的 sidecar 表示
//
// 冲突模型（计划 §9）：
// - 文件 hash 与条目记录的 vaultFileHash 一致：可安全覆盖（幂等跳过或写新修订）。
// - 文件 hash 不一致（CueMind 之外被编辑）：标记 vaultConflict，绝不自动覆盖。
// - 只有应用侧条目更新（version > vaultExportedVersion）：允许写新修订。
// - 双方都变：显式冲突状态，不做静默合并；用户可用 force 显式覆盖。
//
// vault 元数据（file/hash/exportedVersion）记录在 KnowledgeEntry 本身，而非共享
// sidecar：条目 version 是冲突判定的必要输入，且知识条目天然有乐观锁保护。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { KnowledgeEntry } from "@/lib/knowledge-store";
import { assembleMarkdown, computeFileHash, parseFrontmatter, slugifyTerm, type MarkdownPiece } from "@/lib/vault-exporter";

const VAULT_SUBDIR = "cuemind";
const KNOWLEDGE_DIR = "knowledge";
const NAME_CONFLICT_MAX = 99;

export type KnowledgeExportOutcome =
  | { outcome: "saved"; file: string; fileHash: string }
  | { outcome: "skipped"; reason: "unchanged"; file: string }
  | { outcome: "conflict"; file: string; detail: "external-edit" };

function knowledgeDir(root: string): string {
  return path.join(root, VAULT_SUBDIR, KNOWLEDGE_DIR);
}

/** frontmatter 携带冲突检测与应用版本元数据（计划 §9 write model）。 */
export function buildKnowledgeMarkdown(entry: KnowledgeEntry, exportedAt: string): MarkdownPiece {
  const fields: Array<[string, string]> = [
    ["entry_id", `"${entry.id}"`],
    ["slug", `"${entry.slug}"`],
    ["aliases", `[${entry.aliases.map((alias) => `"${alias.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}`).join(", ")}]`],
    ["source_types", `[${entry.sourceTypes.join(", ")}]`],
    ["origin_sessions", `[${entry.originSessionIds.join(", ")}]`],
    ["status", entry.status],
    ["privacy", entry.privacy],
    ["exported_version", String(entry.version)],
    ["exported_at", exportedAt],
    ["updated", entry.updatedAt],
  ];
  const lines = [`# ${entry.title}`, ""];
  if (entry.summary.trim().length > 0) lines.push("## 摘要", "", entry.summary.trim(), "");
  if (entry.content.trim().length > 0) lines.push("## 内容", "", entry.content.trim(), "");
  if (entry.sourceUrls.length > 0) {
    lines.push("## 来源", "", ...entry.sourceUrls.map((url) => `- ${url}`), "");
  }
  return { frontmatter: `---\n${fields.map(([key, value]) => `${key}: ${value}`).join("\n")}\n---`, body: lines.join("\n") };
}

/** 从已有 vault 文件读 entry_id（无 frontmatter 或缺字段 → null）。 */
function entryIdOf(filePath: string): string | null {
  try {
    const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    return parsed?.fields.get("entry_id")?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 冲突感知导出。返回的 next 元数据由调用方 upsert 回 store；
 * conflict 时返回原 entry（只置 vaultConflict），文件内容绝不改写。
 */
export function exportKnowledgeToVault(
  root: string,
  entry: KnowledgeEntry,
  options?: { force?: boolean },
): { result: KnowledgeExportOutcome; next: KnowledgeEntry } {
  const dir = knowledgeDir(root);
  mkdirSync(dir, { recursive: true });
  const exportedAt = new Date().toISOString();

  // 目标文件：优先沿用上次导出路径；否则按 slug 命名，撞名（属于其他条目）时追加序号。
  let fileName = entry.vaultFile
    ? path.basename(entry.vaultFile)
    : `${slugifyTerm(entry.title || entry.slug)}.md`;
  const targetOf = (name: string): string => path.join(dir, name);
  if (!entry.vaultFile) {
    for (let attempt = 2; existsSync(targetOf(fileName)) && entryIdOf(targetOf(fileName)) !== entry.id && attempt <= NAME_CONFLICT_MAX; attempt += 1) {
      fileName = `${slugifyTerm(entry.title || entry.slug)}-${attempt}.md`;
    }
  }
  const filePath = targetOf(fileName);
  const relFile = `${VAULT_SUBDIR}/${KNOWLEDGE_DIR}/${fileName}`;

  const fileExists = existsSync(filePath);
  const currentHash = fileExists ? computeFileHash(readFileSync(filePath, "utf8")) : null;
  const externallyEdited = fileExists && entry.vaultFileHash !== null && currentHash !== entry.vaultFileHash;

  if (externallyEdited && options?.force !== true) {
    // 外部编辑 + 未显式确认：只标记冲突，绝不覆盖用户改动。
    return { result: { outcome: "conflict", file: relFile, detail: "external-edit" }, next: { ...entry, vaultConflict: true } };
  }

  // 幂等：hash 一致且 version 未变（或 force 后内容一致）→ 不重写文件。
  if (fileExists && !externallyEdited && entry.vaultExportedVersion === entry.version && entry.vaultFileHash === currentHash) {
    return { result: { outcome: "skipped", reason: "unchanged", file: relFile }, next: { ...entry, vaultConflict: false } };
  }

  const piece = buildKnowledgeMarkdown(entry, exportedAt);
  const content = assembleMarkdown(piece);
  writeFileSync(filePath, content, "utf8");
  const fileHash = computeFileHash(content);
  return {
    result: { outcome: "saved", file: relFile, fileHash },
    next: {
      ...entry,
      vaultFile: relFile,
      vaultFileHash: fileHash,
      vaultExportedVersion: entry.version,
      vaultExportedAt: exportedAt,
      vaultConflict: false,
    },
  };
}
