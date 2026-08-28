import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bigramTokens,
  getSession,
  getSessionStoreBackend,
  listSessions,
  searchSessions,
  upsertSession,
} from "@/lib/session-store";

// session-store 回归：a) 往返（含中文） b) 幂等 upsert c) updatedAt 降序 + limit
// d) from/to 过滤 e) 中文 2-gram 检索 f) 英文词检索 g) 空 query h) miss → null
// i) bigramTokens 纯函数 j) JSONL 降级实现跑同一用例（子进程 CUEMIND_SESSION_STORE=jsonl）。
// 数据目录可被 CUEMIND_DATA_DIR 覆盖（需在首次使用前设置，session-store 懒初始化）；
// 与 chat-store 共用 cuemind.db，故测试目录必须独立。

if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-session-test-"));
}
const DATA_DIR = path.resolve(process.env.CUEMIND_DATA_DIR);

const BASE_SNAPSHOT = {
  title: "季度规划会",
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:30:00.000Z",
  transcriptChunks: [
    {
      id: "c1",
      text: "我们讨论大模型推理优化的实践",
      timestamp: "2026-08-27T10:00:01.000Z",
      source: "microphone",
      startMs: 0,
      endMs: 12000,
    },
    {
      id: "c2",
      text: "ASR latency matters",
      timestamp: "2026-08-27T10:00:13.000Z",
      source: "microphone",
      startMs: 12000,
      endMs: 20000,
    },
  ],
  suggestionBatches: [],
  chatMessages: [],
  meetingReport: null,
};

function runSuite(): void {
  const backend = getSessionStoreBackend();
  console.log(`session-store backend = ${backend} (data dir: ${DATA_DIR})`);

  // a) upsert + getSession 往返（含中文 title/transcript），派生字段与序列化保真
  upsertSession({ ...BASE_SNAPSHOT, id: "sess-roundtrip" });
  const roundtrip = getSession("sess-roundtrip");
  assert.notEqual(roundtrip, null);
  assert.equal(roundtrip!.title, "季度规划会");
  assert.equal(roundtrip!.createdAt, "2026-08-27T10:00:00.000Z");
  assert.equal(roundtrip!.updatedAt, "2026-08-27T10:30:00.000Z");
  assert.equal(roundtrip!.durationMs, 20000);
  assert.equal(roundtrip!.inputSource, "microphone");
  assert.equal(roundtrip!.cardsJson, null, "SessionSnapshot 无 contextCards → cardsJson=null");
  assert.equal(roundtrip!.metricsJson, null, "SessionSnapshot 无 latencySamples → metricsJson=null");
  const chunks = JSON.parse(roundtrip!.transcriptJson) as Array<{ text: string; startMs: number }>;
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, "我们讨论大模型推理优化的实践");
  assert.equal(chunks[1].startMs, 12000);

  // b) 幂等 upsert：同 id 重写不产生重复行，读回为最新
  upsertSession({
    ...BASE_SNAPSHOT,
    id: "sess-roundtrip",
    title: "季度规划会（更新）",
    updatedAt: "2026-08-27T11:00:00.000Z",
  });
  const afterUpsert = getSession("sess-roundtrip");
  assert.equal(afterUpsert!.title, "季度规划会（更新）");
  assert.equal(afterUpsert!.updatedAt, "2026-08-27T11:00:00.000Z");
  assert.equal(listSessions({ limit: 100 }).filter((s) => s.id === "sess-roundtrip").length, 1);
  // 非法快照抛 Error（调用方 fire-and-forget 静默）
  assert.throws(() => upsertSession({ title: "缺 id", transcriptChunks: [] }));
  assert.throws(() => upsertSession({ id: "sess-invalid", title: "缺 transcript" }));
  assert.throws(() => upsertSession({ id: "sess-invalid", title: "transcript 非数组", transcriptChunks: "oops" }));

  // c) listSessions updatedAt 降序 + limit
  const ordered = [
    { id: "sess-old", updatedAt: "2026-08-26T09:00:00.000Z" },
    { id: "sess-mid", updatedAt: "2026-08-27T09:00:00.000Z" },
    { id: "sess-new", updatedAt: "2026-08-28T09:00:00.000Z" },
  ];
  for (const item of ordered) {
    upsertSession({ ...BASE_SNAPSHOT, id: item.id, updatedAt: item.updatedAt });
  }
  const all = listSessions({ limit: 100 });
  const orderedIds = ordered.map((item) => item.id);
  assert.deepEqual(
    all.filter((s) => orderedIds.includes(s.id)).map((s) => s.id),
    ["sess-new", "sess-mid", "sess-old"],
  );
  assert.equal(listSessions({ limit: 1 }).length, 1);
  assert.equal(listSessions({ limit: 1 })[0].id, "sess-new");
  assert.equal(all.length, 4, "默认数据集共 4 条会话");

  // d) from/to 过滤（updatedAt 含边界）
  const windowed = listSessions({ from: "2026-08-27T00:00:00.000Z", to: "2026-08-27T23:59:59.999Z", limit: 100 });
  assert.deepEqual(
    windowed.map((s) => s.id).sort(),
    ["sess-mid", "sess-roundtrip"],
  );
  const fromOnly = listSessions({ from: "2026-08-28T00:00:00.000Z", limit: 100 });
  assert.deepEqual(fromOnly.map((s) => s.id), ["sess-new"]);

  // e) 中文 2-gram 命中：transcript 含「推理优化」能搜「理优」「推理」
  const zhBigramHits = searchSessions("理优");
  console.log(
    `searchSessions("理优") → ${zhBigramHits.map((hit) => `${hit.session.id}:${hit.score.toFixed(3)}`).join(", ") || "(none)"}`,
  );
  assert.equal(zhBigramHits.some((hit) => hit.session.id === "sess-roundtrip"), true);
  const zhWordHits = searchSessions("推理");
  console.log(
    `searchSessions("推理") → ${zhWordHits.map((hit) => `${hit.session.id}:${hit.score.toFixed(3)}`).join(", ") || "(none)"}`,
  );
  assert.equal(zhWordHits.some((hit) => hit.session.id === "sess-roundtrip"), true);

  // f) 英文词命中（大小写不敏感）
  const enHits = searchSessions("LATENCY");
  assert.equal(enHits.some((hit) => hit.session.id === "sess-roundtrip"), true);
  const enHitsLower = searchSessions("latency");
  assert.equal(enHitsLower.some((hit) => hit.session.id === "sess-roundtrip"), true);

  // g) 空 query → []
  assert.deepEqual(searchSessions(""), []);
  assert.deepEqual(searchSessions("   "), []);

  // h) getSession 不存在 → null
  assert.equal(getSession("sess-missing"), null);

  // i) bigramTokens 纯函数断言（中英混合）
  assert.deepEqual(bigramTokens("推理优化"), ["推理", "理优", "优化"]);
  assert.deepEqual(bigramTokens("ASR 引擎"), ["asr", "引擎"]);
  assert.deepEqual(bigramTokens("Hello, 世界!"), ["hello", "世界"]);
  assert.deepEqual(bigramTokens("端到端 ASR"), ["端到", "到端", "asr"]);
  assert.deepEqual(bigramTokens("好"), ["好"]);
  assert.deepEqual(bigramTokens("A"), ["a"]);
  assert.deepEqual(bigramTokens("  ,. "), []);

  console.log(`session-store suite passed (${backend})`);
}

// j) 子进程以 JSONL 降级实现重跑同一用例（session-store 单例缓存 → 必须隔离进程；
//    独立 CUEMIND_DATA_DIR 避免污染主测试目录的 cuemind.db / sessions.jsonl）
function runJsonlChildSuite(): void {
  const scriptPath = path.resolve(process.argv[1] ?? "scripts/test-session-store.ts");
  const repoRoot = path.resolve(scriptPath, "..", "..");
  const loaderArgs = process.execArgv.length > 0 ? [...process.execArgv] : ["--import", "tsx"];
  const result = spawnSync(process.execPath, [...loaderArgs, scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CUEMIND_SESSION_STORE: "jsonl",
      CUEMIND_DATA_DIR: path.join(DATA_DIR, "jsonl-child"),
    },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  assert.equal(result.status, 0, "JSONL 降级实现测试失败");
  console.log("session-store JSONL fallback suite passed (child process)");
}

function main(): void {
  runSuite();
  const isForcedJsonl = process.env.CUEMIND_SESSION_STORE?.trim().toLowerCase() === "jsonl";
  if (!isForcedJsonl) runJsonlChildSuite();
  console.log("session-store regression tests passed");
}

main();
