// vault/concepts 只读读取（M3-b：search_cards/get_card 数据源合流为 SQLite ∪ vault）。
// 契约同步来源（只读其落盘产物，不依赖其代码）：lib/vault-exporter.ts（M3-a 写方向）——
// - 目录布局：<vaultRoot>/cuemind/concepts/<term-slug>.md（slug 由 slugifyTerm 生成：
//   去文件系统非法字符、空白折叠为 "-"、截 60 字符）。
// - frontmatter（手写 YAML）：aliases / source_types / origin_meetings（简单数组）
//   与 updated（ISO 时间戳）；正文以 `# <term>` 开头，keyPoints 为 "- " 列表行，
//   来源为 "- [title](url)" 列表行，可有「## 变更 <date>」追加小节。
// - <vaultRoot>/.cuemind-export.json sidecar 是写方向的幂等凭据，MCP 只读进程不使用。
// 只读硬约束：本文件全部使用 statSync/readdirSync/readFileSync，无任何写路径；
// fileHash（sha256）仅供调用方做 trace/审计说明——MCP 无写，故不做写前检查。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./db.js";

const VAULT_DIR_ENV = "CUEMIND_VAULT_DIR";
const CONCEPTS_RELATIVE = "cuemind/concepts";

/** 概念文件解析产物（frontmatter 白名单字段 + 正文与审计哈希）。 */
export interface ConceptFile {
  term: string;
  aliases: string[];
  sourceTypes: string[];
  originMeetings: string[];
  updated: string | null;
  body: string;
  fileHash: string;
  relativePath: string;
}

/**
 * vault 根目录解析：CUEMIND_VAULT_DIR（MCP 侧独立 env；主应用写方向用它自身的配置），
 * 缺省 <CUEMIND_DATA_DIR>/vault。目录不存在/不可访问 → null（工具静默跳过 vault 源，非错误）。
 */
export function resolveVaultRoot(): string | null {
  const fromEnv = process.env[VAULT_DIR_ENV]?.trim();
  const root = fromEnv ? path.resolve(fromEnv) : path.join(resolveDataDir(), "vault");
  try {
    if (!statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  return root;
}

/** 列出 <root>/cuemind/concepts/*.md（readdirSync withFileTypes 只取 .md 文件；目录缺失/不可读 → 空数组，静默跳过）。 */
export function listConceptFiles(root: string): string[] {
  try {
    return readdirSync(path.join(root, CONCEPTS_RELATIVE), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(root, CONCEPTS_RELATIVE, entry.name))
      .sort();
  } catch {
    return [];
  }
}

// 手写 frontmatter 解析（零依赖；与 lib/vault-exporter.ts 的 parseFrontmatter 同款实现，
// 两处需同步演进——沿用项目「手写 Atom 正则、不引 XML 依赖」先例）。
// 支持 `key: value` 与 `key: [a, b]` 两种形态，够读 aliases/source_types/
// origin_meetings/updated 即可；无 `---` 围栏 → null（坏文件由调用方跳过）。
function parseFrontmatter(raw: string): { fields: Map<string, string[]>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match === null) return null;
  const fields = new Map<string, string[]>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (key.length === 0) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      const items = inner.length === 0
        ? []
        : inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter((item) => item.length > 0);
      fields.set(key, items);
    } else {
      value = value.replace(/^["']|["']$/g, "");
      fields.set(key, [value]);
    }
  }
  return { fields, body: raw.slice(match[0].length) };
}

// 正文首个 `# <term>` 一级标题（exporter 写概念时恒有；`## 解释` 等二级标题不匹配）。
function termFromBody(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

// slug 还原（有损回退）：slugifyTerm 把空白折叠为 "-"，此处反向把 "-" 读作空格；
// 正文没有 `# ` 标题时才走此分支（正常导出的概念文件不会）。
function termFromSlug(fileName: string): string {
  const slug = fileName.replace(/\.md$/i, "");
  const restored = slug.replace(/-/g, " ").trim();
  return restored.length > 0 ? restored : slug;
}

/**
 * 解析单个概念文件；任何失败（读错误、无 frontmatter 围栏的坏文件）→ null，调用方跳过该文件。
 * body 为剥离 frontmatter 后的正文；relativePath 固定为 cuemind/concepts/<name>.md
 * （与 vault-exporter 的落盘布局一致）。
 */
export function parseConceptFile(filePath: string): ConceptFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (parsed === null) return null;
  const fileName = path.basename(filePath);
  const list = (key: string): string[] => parsed.fields.get(key) ?? [];
  const updated = list("updated")[0];
  return {
    term: termFromBody(parsed.body) ?? termFromSlug(fileName),
    aliases: list("aliases").filter((alias) => alias.length > 0),
    sourceTypes: list("source_types"),
    originMeetings: list("origin_meetings"),
    updated: typeof updated === "string" && updated.length > 0 ? updated : null,
    body: parsed.body,
    fileHash: createHash("sha256").update(raw, "utf8").digest("hex"),
    relativePath: `${CONCEPTS_RELATIVE}/${fileName}`,
  };
}

/**
 * vault 概念子串检索：term 或 aliases 含 query（大小写不敏感 includes）→ 命中列表。
 * 同 term（slug 同名）去重——保留文件名序靠前者；坏文件解析失败即跳过。
 */
export function searchConcepts(root: string, query: string): ConceptFile[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const hits: ConceptFile[] = [];
  const seenTerms = new Set<string>();
  for (const filePath of listConceptFiles(root)) {
    const concept = parseConceptFile(filePath);
    if (concept === null) continue;
    const termKey = concept.term.toLowerCase();
    const matched =
      termKey.includes(needle) || concept.aliases.some((alias) => alias.toLowerCase().includes(needle));
    if (!matched || seenTerms.has(termKey)) continue;
    seenTerms.add(termKey);
    hits.push(concept);
  }
  return hits;
}

/** 精确匹配 term/alias（大小写不敏感 equals）→ ConceptFile | null。 */
export function getConcept(root: string, termOrAlias: string): ConceptFile | null {
  const needle = termOrAlias.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const filePath of listConceptFiles(root)) {
    const concept = parseConceptFile(filePath);
    if (concept === null) continue;
    if (concept.term.toLowerCase() === needle) return concept;
    if (concept.aliases.some((alias) => alias.toLowerCase() === needle)) return concept;
  }
  return null;
}
