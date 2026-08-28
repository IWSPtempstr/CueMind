import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assembleMarkdown,
  buildConceptMarkdown,
  buildMeetingMarkdown,
  computeFileHash,
  exportConceptToVault,
  exportMeetingToVault,
  readSidecar,
  resolveVaultRoot,
  slugifyTerm,
} from "@/lib/vault-exporter";

// vault-exporter 回归（M3-a）：a) folded 折叠块 b) none 不导转写 c) full 逐条 [mm:ss]
// d) concept 新建 frontmatter/正文 e) 追加语义（旧正文保留 + 变更小节 + aliases 合并）
// f) concept 幂等（同 candidateId → skipped） g) 用户编辑检测（hash 变 → 追加且编辑保留）
// h) meeting 不可变（同 meetingId → skipped） i) sidecar 坏 JSON 容错 j) audio_hash 64hex
// k) slug 清理与重名序号 l) 三档透传（none 仍生成会议文件）。
// exporter 的 root 由参数注入（测试写临时目录），CUEMIND_DATA_DIR 仅影响默认 root 解析。

if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-vault-export-test-"));
}

function newRoot(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `cuemind-vault-${name}-`));
}

const BASE_CHUNKS = [
  { id: "c1", text: "我们讨论大模型推理优化的实践", startMs: 0, endMs: 12000, source: "microphone" },
  { id: "c2", text: "ASR latency matters", startMs: 12000, endMs: 20000, source: "microphone" },
];

const BASE_MEETING = {
  id: "meeting-1",
  title: "推理优化专题会",
  topicSummary: "大模型推理优化",
  createdAt: "2026-08-28T10:00:00.000Z",
  transcriptChunks: BASE_CHUNKS,
  meetingReport: { content: "会议围绕推理优化展开讨论，涉及延迟与吞吐权衡。" },
  cards: [{ keyword: "推理优化", candidateId: "cand-1" }],
  asrModel: "/home/work/models/ggml-base.bin",
};

function runSuite(): void {
  // --- markdown 构建 ---
  // a) folded：frontmatter transcript: folded + callout 折叠块 + "> " 前缀
  const folded = buildMeetingMarkdown({ ...BASE_MEETING, exportTranscript: "folded" });
  assert.match(folded.frontmatter, /^---\n/);
  assert.match(folded.frontmatter, /\ntranscript: folded\n/);
  assert.ok(folded.body.includes("> [!note]- 完整转写"), "folded 应含 Obsidian 折叠 callout");
  assert.ok(folded.body.includes("> [00:00] 我们讨论大模型推理优化的实践"), "转写行应有 [mm:ss] 与 > 前缀");
  assert.ok(folded.body.includes("> [00:12] ASR latency matters"));
  assert.match(folded.frontmatter, /\ndate: 2026-08-28T/);
  assert.match(folded.frontmatter, /\nduration: 20000\n/);
  assert.match(folded.frontmatter, /\ninput_source: microphone\n/);
  assert.match(folded.frontmatter, /\nasr_model: ggml-base\.bin\n/, "asr_model 取 basename");
  assert.match(folded.frontmatter, /\ntopic: "大模型推理优化"\n/);
  assert.ok(folded.body.includes("# 推理优化专题会"));
  assert.ok(folded.body.includes("## 主题摘要"));
  assert.ok(folded.body.includes("- [[推理优化]] 推理优化"), "卡片链接用 Obsidian wikilink");

  // b) none：无转写内容、frontmatter transcript: none
  const none = buildMeetingMarkdown({ ...BASE_MEETING, exportTranscript: "none" });
  assert.match(none.frontmatter, /\ntranscript: none\n/);
  assert.ok(!none.body.includes("[!note]"), "none 不渲染折叠块");
  assert.ok(!none.body.includes("[00:00]"), "none 不渲染转写行");
  assert.ok(none.body.includes("## 主题摘要"), "none 仍含摘要");

  // c) full：逐条 [mm:ss] 平铺
  const full = buildMeetingMarkdown({ ...BASE_MEETING, exportTranscript: "full" });
  assert.match(full.frontmatter, /\ntranscript: full\n/);
  assert.ok(full.body.includes("[00:00] 我们讨论大模型推理优化的实践"));
  assert.ok(full.body.includes("[00:12] ASR latency matters"));
  assert.ok(!full.body.includes("> [00:00]"), "full 平铺不加 callout 前缀");

  // j) audio_hash 是内容 hash（64 hex），非音频文件 hash
  const audioHash = /\naudio_hash: "([0-9a-f]+)"\n/.exec(folded.frontmatter)?.[1] ?? "";
  assert.match(audioHash, /^[0-9a-f]{64}$/, "audio_hash 应为 64 位 hex");

  // --- concept 构建 ---
  // d) 新建：frontmatter aliases/source_types/updated、正文 keyPoints、来源链接
  const card = {
    candidateId: "cand-1",
    keyword: "推理优化",
    keyPoints: ["要点一：量化降低显存", "要点二：KV cache 复用"],
    explanation: "旧格式解释文本",
    originMeeting: "sess-roundtrip",
    sources: [
      { title: "论文 A", url: "https://arxiv.org/abs/2401.00001", snippet: "量化加速推理", sourceType: "arxiv" },
      { title: "网页 B", url: "https://example.com/b", snippet: "实践总结", sourceType: "web" },
    ],
  };
  const fresh = buildConceptMarkdown(card);
  assert.match(fresh.frontmatter, /^---\naliases: \["推理优化"\]\n/);
  assert.match(fresh.frontmatter, /\nsource_types: \[arxiv, web\]\n/);
  assert.match(fresh.frontmatter, /\norigin_meetings: \[sess-roundtrip\]\n/);
  assert.match(fresh.frontmatter, /\nupdated: \d{4}-\d{2}-\d{2}T/);
  assert.ok(fresh.body.startsWith("# 推理优化"));
  assert.ok(fresh.body.includes("- 要点一：量化降低显存"), "keyPoints 渲染为列表");
  assert.ok(fresh.body.includes("[论文 A](https://arxiv.org/abs/2401.00001)"), "来源为 markdown 链接");
  assert.ok(fresh.body.includes("  > 量化加速推理"), "snippet 折叠引用");

  // e) 追加语义：prev 存在 → 旧正文保留 + 「## 变更」小节 + aliases/origin_meetings 合并
  const prevContent = assembleMarkdown(fresh);
  const card2 = {
    candidateId: "cand-1",
    keyword: "推理优化",
    keyPoints: ["更新要点：投机解码"],
    originMeeting: "sess-second",
    sources: [{ title: "论文 C", url: "https://arxiv.org/abs/2402.00003", snippet: "投机解码", sourceType: "arxiv" }],
  };
  const appended = buildConceptMarkdown(card2, prevContent);
  assert.ok(appended.appendSection !== undefined, "追加语义应返回 appendSection");
  assert.ok(appended.body.includes("- 要点一：量化降低显存"), "旧正文保留");
  assert.ok(appended.body.includes("[论文 A](https://arxiv.org/abs/2401.00001)"), "旧来源保留");
  assert.ok(appended.body.includes("## 变更 "), "追加变更小节");
  assert.ok(appended.body.includes("- 重新沉淀：更新解释与来源"));
  assert.ok(appended.body.includes("[论文 C](https://arxiv.org/abs/2402.00003)"), "新来源列表");
  assert.match(appended.frontmatter, /^---\naliases: \["推理优化"\]/, "aliases 并集去重");
  const mergedOrigins = /\norigin_meetings: \[([^\]]*)\]\n/.exec(appended.frontmatter)?.[1] ?? "";
  assert.ok(mergedOrigins.includes("sess-roundtrip") && mergedOrigins.includes("sess-second"), "origin_meetings 合并（并集）");
  // 完全无 frontmatter 的用户内容也绝不覆盖
  const rawPrev = "# 用户手写的笔记\n\n自定义内容，没有 frontmatter。";
  const appendedRaw = buildConceptMarkdown(card2, rawPrev);
  assert.ok(appendedRaw.body.includes("自定义内容，没有 frontmatter。"), "无 frontmatter 的旧正文也保留");
  assert.ok(appendedRaw.body.includes("## 变更 "));

  // --- 落盘与幂等 ---
  // f) concept 幂等：同 candidateId 二次 → skipped already-exported，文件不变
  const rootF = newRoot("idem");
  const savedF = exportConceptToVault(rootF, card);
  assert.equal(savedF.outcome, "saved");
  const filePathF = path.join(rootF, savedF.file);
  const contentF1 = readFileSync(filePathF, "utf8");
  const sidecarF1 = readSidecar(rootF);
  assert.equal(sidecarF1["cand-1"].file, savedF.file);
  assert.equal(sidecarF1["cand-1"].fileHash, computeFileHash(contentF1));
  const skippedF = exportConceptToVault(rootF, { ...card, keyPoints: ["变化了也没用"] });
  assert.equal(skippedF.outcome, "skipped");
  assert.ok(skippedF.outcome === "skipped" && skippedF.reason === "already-exported");
  assert.equal(readFileSync(filePathF, "utf8"), contentF1, "hash 一致不重写");

  // g) 用户编辑检测：手工改文件（hash 变）→ 再导出 → 走追加且旧编辑内容保留
  const edited = `${contentF1}\n## 用户补充\n\n手工编辑的内容。`;
  writeFileSync(filePathF, edited, "utf8");
  const appendedF = exportConceptToVault(rootF, card2);
  assert.equal(appendedF.outcome, "appended", "hash 不一致 → 追加路径");
  const contentF2 = readFileSync(filePathF, "utf8");
  assert.ok(contentF2.includes("手工编辑的内容。"), "用户编辑绝不覆盖");
  assert.ok(contentF2.includes("## 变更 "), "追加变更小节");
  assert.ok(contentF2.includes("[论文 C](https://arxiv.org/abs/2402.00003)"));
  assert.equal(readSidecar(rootF)["cand-1"].fileHash, computeFileHash(contentF2), "sidecar 记录新 hash");

  // h) meeting 不可变：同 meetingId 二次 → skipped（无论内容变化）
  const rootH = newRoot("meeting");
  const savedH1 = exportMeetingToVault(rootH, BASE_MEETING);
  assert.equal(savedH1.outcome, "saved");
  assert.match(savedH1.file, /^cuemind\/meetings\/2026-08-28-大模型推理优化\.md$/);
  const filePathH1 = path.join(rootH, savedH1.file);
  const contentH1 = readFileSync(filePathH1, "utf8");
  const replayedH = exportMeetingToVault(rootH, { ...BASE_MEETING, transcriptChunks: [...BASE_CHUNKS, { id: "c3", text: "补充转写", startMs: 20000, endMs: 25000, source: "microphone" }] });
  assert.equal(replayedH.outcome, "skipped", "同 meetingId 重放 → skipped（落盘后不可变）");
  assert.ok(replayedH.outcome === "skipped" && replayedH.reason === "already-exported");
  assert.equal(readFileSync(filePathH1, "utf8"), contentH1, "meeting 文件不被覆盖");

  // i) sidecar 读写容错：坏 JSON → {}（导出流程继续可用）
  const rootI = newRoot("sidecar");
  writeFileSync(path.join(rootI, ".cuemind-export.json"), "{ 坏 JSON !!!", "utf8");
  assert.deepEqual(readSidecar(rootI), {}, "坏 JSON → {}");
  const savedI = exportConceptToVault(rootI, card);
  assert.equal(savedI.outcome, "saved", "sidecar 容错后仍可导出");
  // sidecar 文件缺失 → {}
  const rootI2 = newRoot("sidecar-missing");
  assert.deepEqual(readSidecar(rootI2), {});

  // k) slug 清理 + 重名序号：同日同 slug 无 sidecar 记录 → -2
  assert.equal(slugifyTerm('a/b\\c:d*e?f"g<h>i|j k'), "abcdefghij-k", "非法字符清理、空格→-");
  assert.equal(slugifyTerm("  --推理--优化  "), "推理-优化", "连续 - 合并、首尾修剪");
  assert.ok(slugifyTerm("x".repeat(100)).length <= 60, "截 60 字符");
  assert.equal(slugifyTerm("///"), "untitled", "空结果回退");
  const rootK = newRoot("conflict");
  const savedK1 = exportMeetingToVault(rootK, { ...BASE_MEETING, id: "meeting-k1" });
  assert.equal(savedK1.outcome, "saved");
  const savedK2 = exportMeetingToVault(rootK, { ...BASE_MEETING, id: "meeting-k2" });
  assert.equal(savedK2.outcome, "saved");
  assert.ok(savedK2.file.endsWith("-2.md"), `重名追加序号：${savedK2.file}`);
  assert.ok(existsSync(path.join(rootK, savedK1.file)) && existsSync(path.join(rootK, savedK2.file)));

  // l) 三档透传：exportTranscript=none 时 meeting 文件仍生成（frontmatter+摘要+卡片链接）
  const rootL = newRoot("none-mode");
  const savedL = exportMeetingToVault(rootL, { ...BASE_MEETING, id: "meeting-none", exportTranscript: "none" });
  assert.equal(savedL.outcome, "saved");
  const contentL = readFileSync(path.join(rootL, savedL.file), "utf8");
  assert.match(contentL, /^---\n[\s\S]*\ntranscript: none\n[\s\S]*\n---\n/);
  assert.ok(contentL.includes("## 主题摘要"));
  assert.ok(contentL.includes("- [[推理优化]] 推理优化"));
  assert.ok(!contentL.includes("[00:00]"), "none 档不写转写正文");

  // resolveVaultRoot：显式参数 > 默认 CUEMIND_DATA_DIR/vault
  assert.equal(resolveVaultRoot("/tmp/m3-vault-test"), path.resolve("/tmp/m3-vault-test"));
  assert.equal(resolveVaultRoot("  "), path.join(path.resolve(process.env.CUEMIND_DATA_DIR!), "vault"));

  console.log("vault-exporter markdown/idempotency suite passed");
}

function main(): void {
  runSuite();
  console.log("vault-exporter regression tests passed");
}

main();
