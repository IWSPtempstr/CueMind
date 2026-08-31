import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getKnowledgeMemoryStore, resetKnowledgeMemoryStoreForTests } from "@/lib/knowledge-memory-store";
import type { MemoryKind, MemoryRecord } from "@/lib/knowledge-memory";

interface EvalCase {
  id: string;
  query: string;
  kind?: MemoryKind;
  expectedId: string | null;
}

interface CaseResult extends EvalCase {
  returnedIds: string[];
  matchedBy: string | null;
  latencyMs: number;
  passed: boolean;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(index, 0)];
}

const records: MemoryRecord[] = [
  {
    id: "card-kv-cache",
    kind: "knowledge_card",
    keyword: "KV Cache",
    aliases: ["键值缓存", "kv-cache"],
    explanation: "复用已计算的键和值，减少重复计算。",
    keyPoints: ["适合长序列推理"],
    sourceUrls: ["https://example.test/kv"],
    originMeeting: "meeting-1",
    status: "active",
    validUntil: null,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  },
  {
    id: "decision-q4",
    kind: "meeting_decision",
    decision: "采用 Q4 量化方案",
    scope: "本地模型部署",
    originMeeting: "meeting-1",
    status: "active",
    validUntil: "2026-12-31T00:00:00.000Z",
    decidedAt: "2026-08-30T10:10:00.000Z",
    createdAt: "2026-08-30T10:10:00.000Z",
    updatedAt: "2026-08-30T10:10:00.000Z",
  },
  {
    id: "decision-old",
    kind: "meeting_decision",
    decision: "采用 Q2 量化方案",
    scope: "本地模型部署",
    originMeeting: "meeting-0",
    status: "superseded",
    validUntil: null,
    decidedAt: "2026-08-20T10:10:00.000Z",
    createdAt: "2026-08-20T10:10:00.000Z",
    updatedAt: "2026-08-20T10:10:00.000Z",
  },
];

const cases: EvalCase[] = [
  { id: "exact", query: "KV Cache", expectedId: "card-kv-cache" },
  { id: "alias", query: "键值缓存", kind: "knowledge_card", expectedId: "card-kv-cache" },
  { id: "fts", query: "长序列推理", expectedId: "card-kv-cache" },
  { id: "decision", query: "Q4 量化", kind: "meeting_decision", expectedId: "decision-q4" },
  { id: "superseded-filter", query: "Q2 量化", kind: "meeting_decision", expectedId: null },
  { id: "empty", query: "不存在的主题", expectedId: null },
];

function run(): void {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-local-memory-eval-"));
  delete process.env.CUEMIND_KNOWLEDGE_MEMORY_STORE;
  resetKnowledgeMemoryStoreForTests();
  const store = getKnowledgeMemoryStore();
  store.upsert(records);
  const results: CaseResult[] = cases.map((testCase) => {
    const started = performance.now();
    const hits = store.search({ query: testCase.query, kind: testCase.kind, limit: 3 });
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const returnedIds = hits.map((hit) => hit.id);
    const passed = testCase.expectedId === null ? returnedIds.length === 0 : returnedIds[0] === testCase.expectedId;
    return { ...testCase, returnedIds, matchedBy: hits[0]?.matchedBy ?? null, latencyMs, passed };
  });
  const outputDir = process.env.LOCAL_MEMORY_OUTPUT_DIR?.trim() || path.join(process.cwd(), "reports", "local-memory", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outputDir, { recursive: true });
  const latencies = results.map((result) => result.latencyMs);
  const scorecard = {
    evidenceBoundary: "fixture",
    backend: store.backend,
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    noNetwork: true,
  };
  writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify({ evidenceBoundary: "fixture", backend: store.backend, recordCount: records.length, generatedAt: new Date().toISOString() }, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "cases.jsonl"), `${results.map((result) => JSON.stringify(result)).join("\n")}\n`);
  writeFileSync(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "report.md"), [
    "# Local memory evaluation",
    "",
    "Evidence boundary: fixture; application data directory: temporary; no network calls.",
    "",
    `- Backend: ${store.backend}`,
    `- Cases: ${scorecard.passed}/${scorecard.total} passed`,
    `- P50/P95: ${scorecard.p50Ms}/${scorecard.p95Ms} ms`,
    "- Covered: exact, alias, FTS, meeting-decision kind filter, superseded filter, empty result.",
  ].join("\n") + "\n");
  if (scorecard.failed > 0) process.exitCode = 1;
  console.log(JSON.stringify({ outputDir, ...scorecard }));
}

run();
