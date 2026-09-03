// Vault exporter (M3-a write direction): meetings + concepts → local markdown vault.
//
// Directory contract (docs/plans/2026-08-27-cuemind-knowledge-export-mcp-plan.md, M3):
//   <vaultRoot>/cuemind/meetings/<YYYY-MM-DD>-<topic-slug>.md   — written once, immutable
//   <vaultRoot>/cuemind/concepts/<term-slug>.md                  — append-only updates
//   <vaultRoot>/.cuemind-export.json                             — idempotency sidecar
//
// Hard rules: frontmatter YAML is hand-assembled (zero dependencies, same spirit as
// the hand-written Atom regex precedent); audio/trace/secrets are never written —
// audio_hash is a content hash of chunk ids+texts, not a file hash (decision 32).
// Meetings are immutable after first write (decision 61); concepts are append-only
// and never overwrite user edits.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AskExchange } from "@/lib/ask-history";
import { createVaultEntry } from "@/lib/vault-governance";
import { buildTimeline, type Timeline } from "@/lib/timeline";
import type { RedactionManifest } from "@/lib/redaction";
import { getKnowledgeMemoryStore } from "@/lib/knowledge-memory-store";
import type { MeetingDecisionRecord } from "@/lib/knowledge-memory";

export type VaultTranscriptMode = "none" | "folded" | "full";

const DATA_DIR_ENV = "CUEMIND_DATA_DIR";
const VAULT_DIR_ENV = "CUEMIND_VAULT_DIR";
const VAULT_SUBDIR = "cuemind";
const MEETINGS_DIR = "meetings";
const CONCEPTS_DIR = "concepts";
const SIDECAR_FILE = ".cuemind-export.json";
const SLUG_MAX_CHARS = 60;
const NAME_CONFLICT_MAX = 99;
const SUMMARY_FALLBACK_CHARS = 200;
const ASK_QUESTION_CHARS = 500;
const ASK_ANSWER_CHARS = 2_000;

export interface VaultMeetingChunk {
  id?: string;
  text: string;
  startMs?: number;
  endMs?: number;
  source?: string;
}

export interface VaultMeetingCardLink {
  keyword: string;
  candidateId: string;
}

export interface MeetingMarkdownArgs {
  id: string;
  title: string;
  topicSummary?: string | null;
  createdAt: string;
  transcriptChunks: VaultMeetingChunk[];
  meetingReport?: { content: string } | null;
  cards?: VaultMeetingCardLink[];
  /** settings.localWhisperModelPath 的 basename（前端传）；空 → "unknown"。 */
  asrModel?: string | null;
  exportTranscript?: VaultTranscriptMode;
  /** 会中询问问答对（可选）；exportTranscript === "none" 时不渲染该小节。 */
  asks?: AskExchange[];
  decisions?: MeetingDecisionRecord[];
  timeline?: Timeline;
  redactionManifest?: RedactionManifest;
}

export interface VaultConceptSource {
  title: string;
  url: string;
  snippet?: string;
  sourceType?: string;
}

export interface ConceptCardInput {
  id?: string;
  candidateId: string;
  keyword: string;
  keyPoints?: string[];
  explanation?: string;
  sources?: VaultConceptSource[];
  /** candidateId 对应会话（sessionId）或 session 名；写入 origin_meetings。 */
  originMeeting?: string;
}

export interface MarkdownPiece {
  frontmatter: string;
  body: string;
  /** concept 追加语义时为新追加的小节文本（meeting 恒为 undefined）。 */
  appendSection?: string;
}

export type MeetingExportOutcome =
  | { outcome: "saved"; file: string; fileHash: string }
  | { outcome: "skipped"; reason: "already-exported"; file: string };

export type ConceptExportOutcome =
  | { outcome: "saved"; file: string; fileHash: string }
  /** 用户编辑过（现文件 hash ≠ sidecar 记录）或 sidecar 缺失但文件已存在 → 追加小节，绝不覆盖。 */
  | { outcome: "appended"; file: string; appendSection: string }
  | { outcome: "skipped"; reason: "already-exported"; file: string };

export interface SidecarEntry {
  file: string;
  fileHash: string;
  exportedAt: string;
}

export type Sidecar = Record<string, SidecarEntry>;

// --- path resolution ---

function resolveDataDir(): string {
  const fromEnv = process.env[DATA_DIR_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), ".data");
}

/** Library resolver retains an explicit path for trusted local callers. HTTP routes call it without a request value. */
export function resolveVaultRoot(explicitPath?: string): string {
  const explicit = explicitPath?.trim();
  if (explicit) return path.resolve(explicit);
  const fromEnv = process.env[VAULT_DIR_ENV]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(resolveDataDir(), "vault");
}

// --- slug ---

/** 去文件系统非法字符 /\\:*?"<>| 与控制符，空格→-，截 60 字符；空结果回退 "untitled"。 */
export function slugifyTerm(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return cleaned.length > 0 ? cleaned : "untitled";
}

// --- hashing ---

/** sha256 hex of the markdown file content — sidecar 幂等与用户编辑检测的依据。 */
export function computeFileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** audio_hash：chunk id+text 拼接的内容 hash（音频文件从不落盘，决策 32）。 */
function computeAudioHash(chunks: VaultMeetingChunk[]): string {
  const joined = chunks.map((chunk) => `${chunk.id ?? ""}\u0000${chunk.text}`).join("\u0001");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

// --- hand-written YAML (zero dependencies) ---

function yamlScalar(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value) && value.trim() === value) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

function frontmatterBlock(fields: Array<[string, string]>): string {
  const lines = fields.map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---`;
}

/**
 * 手写 frontmatter 解析（沿用「手写 Atom 正则、不引 XML 依赖」先例）：
 * 支持 `key: value` 与 `key: [a, b]` 两种形态，够读 aliases/source_types/
 * origin_meetings/updated 即可；无 frontmatter 返回 null。
 */
export function parseFrontmatter(raw: string): { fields: Map<string, string[]>; body: string } | null {
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
      const items = inner.length === 0 ? [] : inner.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter((item) => item.length > 0);
      fields.set(key, items);
    } else {
      value = value.replace(/^["']|["']$/g, "");
      fields.set(key, [value]);
    }
  }
  return { fields, body: raw.slice(match[0].length) };
}

// --- time formatting ---

function formatTimestamp(startMs: number | undefined): string {
  const totalSeconds = typeof startMs === "number" && Number.isFinite(startMs) && startMs > 0 ? Math.floor(startMs / 1000) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function datePrefix(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function safeIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// --- meeting markdown ---

function flattenInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 会中询问小节（问题 + 答案摘要 + 来源链接）；无问答对时返回空数组。 */
function buildAskSection(asks: readonly AskExchange[]): string[] {
  if (asks.length === 0) return [];
  const lines = ["## 会中询问", ""];
  for (const exchange of asks) {
    const question = flattenInline(exchange.question).slice(0, ASK_QUESTION_CHARS);
    const answer = flattenInline(exchange.answer).slice(0, ASK_ANSWER_CHARS);
    if (question.length === 0 || answer.length === 0) continue;
    lines.push(`**问**：${question}`, "", `**答**：${answer}`);
    const sources = exchange.sources ?? [];
    if (sources.length > 0) {
      const links = sources.map((source) => {
        const title = flattenInline(source.title).slice(0, 200) || "来源";
        return `[${title}](${source.url})`;
      });
      lines.push("", `来源：${links.join("、")}`);
    }
    lines.push("");
  }
  return lines;
}

function buildDecisionSection(decisions: readonly MeetingDecisionRecord[]): string[] {
  const valid = decisions.filter((decision) => decision.kind === "meeting_decision" && decision.decision.trim().length > 0);
  if (valid.length === 0) return [];
  const lines = ["## 会议决定", ""];
  for (const decision of valid) {
    const scope = decision.scope?.trim();
    lines.push(`- ${flattenInline(decision.decision)}`);
    if (scope) lines.push(`  - 范围：${flattenInline(scope)}`);
    lines.push(`  - 状态：${decision.status}`);
    if (decision.validUntil) lines.push(`  - 有效至：${decision.validUntil}`);
  }
  lines.push("");
  return lines;
}

/** 会议笔记 markdown：frontmatter 契约 date/duration/input_source/asr_model/audio_hash/transcript/topic。 */
export function buildMeetingMarkdown(args: MeetingMarkdownArgs): MarkdownPiece {
  const mode: VaultTranscriptMode = args.exportTranscript === "none" || args.exportTranscript === "full" ? args.exportTranscript : "folded";
  const chunks = args.transcriptChunks.filter((chunk) => typeof chunk?.text === "string");

  let minStartMs: number | null = null;
  let maxEndMs: number | null = null;
  const sources: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk.startMs === "number" && Number.isFinite(chunk.startMs)) {
      minStartMs = minStartMs === null ? chunk.startMs : Math.min(minStartMs, chunk.startMs);
    }
    if (typeof chunk.endMs === "number" && Number.isFinite(chunk.endMs)) {
      maxEndMs = maxEndMs === null ? chunk.endMs : Math.max(maxEndMs, chunk.endMs);
    }
    if (typeof chunk.source === "string" && chunk.source.length > 0 && !sources.includes(chunk.source)) {
      sources.push(chunk.source);
    }
  }
  const durationMs = minStartMs !== null || maxEndMs !== null ? Math.max((maxEndMs ?? 0) - (minStartMs ?? 0), 0) : null;
  const inputSource = sources.length === 0 ? "null" : yamlScalar(sources.length === 1 ? sources[0] : sources.join(","));
  const topic = args.topicSummary?.trim() || args.title;

  const frontmatter = frontmatterBlock([
    ["date", safeIso(args.createdAt)],
    ["duration", durationMs === null ? "null" : String(durationMs)],
    ["input_source", inputSource],
    ["asr_model", yamlScalar(basenameOf(args.asrModel) || "unknown")],
    ["audio_hash", `"${computeAudioHash(chunks)}"`],
    ["transcript", mode],
    ["topic", yamlScalar(topic)],
  ]);

  const lines: string[] = [`# ${args.title}`, ""];

  // 主题摘要段：topicSummary 优先，缺省取 meetingReport 前 200 字。
  const summary = args.topicSummary?.trim()
    || (args.meetingReport?.content ?? "").trim().slice(0, SUMMARY_FALLBACK_CHARS);
  if (summary.length > 0) {
    lines.push("## 主题摘要", "", summary, "");
  }

  lines.push(...buildDecisionSection(args.decisions ?? []));

  const cards = (args.cards ?? []).filter((card) => typeof card?.keyword === "string" && card.keyword.trim().length > 0);
  if (cards.length > 0) {
    lines.push("## 卡片链接", "", ...cards.map((card) => `- [[${slugifyTerm(card.keyword)}]] ${card.keyword}`), "");
  }

  // 会中询问小节：受决策 64 三档开关约束——none 档不导（隐私最小化），
  // folded/full 档才渲染；frontmatter 契约不变。
  if (mode !== "none") {
    lines.push(...buildAskSection(args.asks ?? []));
  }

  if (mode === "folded") {
    lines.push("> [!note]- 完整转写", ...chunks.map((chunk) => `> [${formatTimestamp(chunk.startMs)}] ${chunk.text}`), "");
  } else if (mode === "full") {
    lines.push("## 完整转写", "", ...chunks.map((chunk) => `[${formatTimestamp(chunk.startMs)}] ${chunk.text}`), "");
  }
  // mode === "none"：不渲染转写正文（frontmatter 如实 transcript: none）。

  return { frontmatter, body: lines.join("\n") };
}

function basenameOf(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  return value.split(/[\\/]/).pop() ?? "";
}

// --- concept markdown ---

function sourceLines(sources: VaultConceptSource[]): string[] {
  return sources.map((source) => {
    const snippet = typeof source.snippet === "string" ? source.snippet.trim() : "";
    const lines = [`- [${source.title}](${source.url})`];
    if (snippet.length > 0) lines.push(`  > ${snippet.replaceAll("\n", " ")}`);
    return lines.join("\n");
  });
}

/**
 * 概念卡片 markdown。prev 非空（文件已存在）时走追加语义：
 * 旧正文原样保留，追加「## 变更」小节 + 新来源列表；frontmatter 合并
 * aliases/origin_meetings/source_types 并集，updated 刷新为当前时间。
 */
export function buildConceptMarkdown(card: ConceptCardInput, prev?: string | null): MarkdownPiece {
  const now = new Date().toISOString();
  const sources = (card.sources ?? []).filter((source) => typeof source?.url === "string" && source.url.length > 0);
  const sourceTypes = [...new Set(sources.map((source) => (source.sourceType ?? "web").trim() || "web"))];
  const origin = card.originMeeting?.trim() || card.candidateId;

  let aliases = [card.keyword];
  let originMeetings = [origin];
  let mergedSourceTypes = sourceTypes;
  let appendSection: string | undefined;

  if (typeof prev === "string" && prev.trim().length > 0) {
    const parsed = parseFrontmatter(prev);
    const oldBody = (parsed?.body ?? prev).trim();
    aliases = [...new Set([...aliases, ...(parsed?.fields.get("aliases") ?? [])])];
    originMeetings = [...new Set([...originMeetings, ...(parsed?.fields.get("origin_meetings") ?? [])])];
    mergedSourceTypes = [...new Set([...sourceTypes, ...(parsed?.fields.get("source_types") ?? [])])];
    appendSection = ["", "## 变更 " + now.slice(0, 10), "", "- 重新沉淀：更新解释与来源", "", ...sourceLines(sources)].join("\n");
    const frontmatter = frontmatterBlock([
      ["aliases", yamlList(aliases)],
      ["source_types", yamlList(mergedSourceTypes)],
      ["origin_meetings", yamlList(originMeetings)],
      ["updated", now],
    ]);
    // 绝不覆盖正文：旧正文（含用户编辑）原样在前，追加小节在后。
    return { frontmatter, body: `${oldBody}\n${appendSection}`, appendSection };
  }

  const explanationLines: string[] = [];
  if (card.keyPoints && card.keyPoints.length > 0) {
    explanationLines.push(...card.keyPoints.map((point) => `- ${point}`));
  } else if (card.explanation && card.explanation.trim().length > 0) {
    explanationLines.push(card.explanation.trim());
  }

  const lines = [`# ${card.keyword}`, ""];
  if (explanationLines.length > 0) {
    lines.push("## 解释", "", ...explanationLines, "");
  }
  if (sources.length > 0) {
    lines.push("## 来源", "", ...sourceLines(sources), "");
  }

  const frontmatter = frontmatterBlock([
    ["aliases", yamlList(aliases)],
    ["source_types", yamlList(mergedSourceTypes)],
    ["origin_meetings", yamlList(originMeetings)],
    ["updated", now],
  ]);
  return { frontmatter, body: lines.join("\n") };
}

export function assembleMarkdown(piece: MarkdownPiece): string {
  return `${piece.frontmatter}\n${piece.body}`;
}

// --- sidecar ---

function sidecarPath(root: string): string {
  return path.join(root, SIDECAR_FILE);
}

/** 读写容错：不存在或坏 JSON → {}。 */
export function readSidecar(root: string): Sidecar {
  try {
    const raw = readFileSync(sidecarPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const sidecar: Sidecar = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== "string" || typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.file !== "string" || typeof entry.fileHash !== "string" || typeof entry.exportedAt !== "string") continue;
      sidecar[key] = { file: entry.file, fileHash: entry.fileHash, exportedAt: entry.exportedAt };
    }
    return sidecar;
  } catch {
    return {};
  }
}

function writeSidecar(root: string, sidecar: Sidecar): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(sidecarPath(root), `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

// --- export operations ---

function meetingsDir(root: string): string {
  return path.join(root, VAULT_SUBDIR, MEETINGS_DIR);
}

function conceptsDir(root: string): string {
  return path.join(root, VAULT_SUBDIR, CONCEPTS_DIR);
}

/**
 * 会议导出。幂等语义：meetings 落盘后不可变（决策 61）——同 meetingId 已在
 * sidecar → skipped "already-exported"，无论现文件 hash 是否一致（与 concepts 的
 * 追加语义不同）。重名冲突（同日同 slug 已存在且 sidecar 无记录）→ 追加序号 -2、-3。
 */
export function exportMeetingToVault(root: string, meeting: MeetingMarkdownArgs): MeetingExportOutcome {
  const sidecar = readSidecar(root);
  const existing = sidecar[meeting.id];
  if (existing) {
    return { outcome: "skipped", reason: "already-exported", file: existing.file };
  }

  const piece = buildMeetingMarkdown(meeting);
  const content = assembleMarkdown(piece);
  const dir = meetingsDir(root);
  mkdirSync(dir, { recursive: true });

  const slug = slugifyTerm(meeting.topicSummary?.trim() || meeting.title);
  const prefix = datePrefix(meeting.createdAt);
  let fileName = `${prefix}-${slug}.md`;
  for (let attempt = 2; existsSync(path.join(dir, fileName)) && attempt <= NAME_CONFLICT_MAX; attempt += 1) {
    fileName = `${prefix}-${slug}-${attempt}.md`;
  }

  writeFileSync(path.join(dir, fileName), content, "utf8");
  // Keep the sidecar useful for replay even though cards/asks may not have
  // their own timestamps in the current Vault contract. Their stable IDs are
  // still preserved so a later player can resolve them against session data.
  const timeline = meeting.timeline ?? buildTimeline({
    transcriptChunks: meeting.transcriptChunks.map((chunk, index) => ({
      id: chunk.id ?? `chunk-${index + 1}`,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
    })),
    cards: (meeting.cards ?? []).map((card) => ({ candidateId: card.candidateId })),
    asks: (meeting.asks ?? []).map((_, index) => ({ id: `ask-${index + 1}` })),
    report: meeting.meetingReport ? { id: "meeting-report" } : undefined,
  });
  writeFileSync(path.join(dir, `${fileName}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
  const redactionManifest = meeting.redactionManifest ?? {
    ruleVersion: "redaction-v1" as const,
    manualReviewRequired: true as const,
    replacementCounts: {},
  };
  writeFileSync(path.join(dir, `${fileName}.redaction-manifest.json`), `${JSON.stringify(redactionManifest, null, 2)}\n`, "utf8");
  try {
    const memory = getKnowledgeMemoryStore();
    if (meeting.decisions && meeting.decisions.length > 0) memory.upsert(meeting.decisions);
  } catch {
    // Vault export remains authoritative; an unavailable derived index must not
    // turn a successful, immutable meeting export into a failed request.
  }
  const fileHash = computeFileHash(content);
  const relFile = `${VAULT_SUBDIR}/${MEETINGS_DIR}/${fileName}`;
  sidecar[meeting.id] = { file: relFile, fileHash, exportedAt: new Date().toISOString() };
  writeSidecar(root, sidecar);
  return { outcome: "saved", file: relFile, fileHash };
}

/**
 * 概念导出（幂等键 = candidateId，候选账本 ID）。
 * - sidecar 有记录且现文件 hash 一致 → skipped "already-exported"（不写）。
 * - sidecar 有记录但 hash 不一致（用户编辑过）→ 保留现文件全文，追加「## 变更」小节，sidecar 记新 hash。
 * - sidecar 无记录但目标文件已存在 → 同样按追加处理（绝不覆盖用户内容）。
 * - 文件不存在 → 新建。
 * concepts/ 永不受转写三档开关影响（始终完整导出）。
 */
export function exportConceptToVault(root: string, card: ConceptCardInput): ConceptExportOutcome {
  const sidecar = readSidecar(root);
  const key = card.candidateId;
  const dir = conceptsDir(root);
  mkdirSync(dir, { recursive: true });
  const fileName = `${slugifyTerm(card.keyword)}.md`;
  const relFile = `${VAULT_SUBDIR}/${CONCEPTS_DIR}/${fileName}`;
  const filePath = path.join(dir, fileName);

  const existingEntry = sidecar[key];
  const fileExists = existsSync(filePath);
  if (existingEntry && fileExists) {
    const current = readFileSync(filePath, "utf8");
    if (computeFileHash(current) === existingEntry.fileHash) {
      return { outcome: "skipped", reason: "already-exported", file: existingEntry.file };
    }
  }

  const prev = fileExists ? readFileSync(filePath, "utf8") : null;
  const piece = buildConceptMarkdown(card, prev);
  const content = assembleMarkdown(piece);
  writeFileSync(filePath, content, "utf8");
  const indexedAt = new Date().toISOString();
  const sourceUrls = (card.sources ?? [])
    .filter((source) => typeof source?.url === "string" && source.url.length > 0)
    .map((source) => source.url);
  try {
    getKnowledgeMemoryStore().upsert([{
      id: card.candidateId,
      kind: "knowledge_card",
      keyword: card.keyword.trim(),
      aliases: [card.keyword.trim()],
      explanation: card.explanation?.trim() ?? "",
      keyPoints: card.keyPoints,
      sourceUrls,
      originMeeting: card.originMeeting?.trim() || card.candidateId,
      status: "active",
      validUntil: null,
      createdAt: indexedAt,
      updatedAt: indexedAt,
    }]);
  } catch {
    // The markdown Vault remains the source of truth; index failures are
    // intentionally non-blocking and are recoverable through a rebuild.
  }

  sidecar[key] = { file: relFile, fileHash: computeFileHash(content), exportedAt: new Date().toISOString() };
  writeSidecar(root, sidecar);

  // 7.4：概念导出同时登记治理索引；Markdown 仍是用户可读的沉淀产物。
  const firstSource = card.sources?.find((source) => typeof source?.url === "string" && source.url.length > 0);
  createVaultEntry(root, {
    entryId: `concept:${slugifyTerm(card.keyword)}`,
    title: card.keyword,
    body: content,
    sourceUrl: firstSource?.url ?? "",
    sourceType: card.sources?.[0]?.sourceType,
    highRisk: piece.appendSection !== undefined,
    actor: "cuemind-exporter",
  });

  if (piece.appendSection !== undefined) {
    return { outcome: "appended", file: relFile, appendSection: piece.appendSection };
  }
  return { outcome: "saved", file: relFile, fileHash: sidecar[key].fileHash };
}
