import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendCandidates,
  countCandidates,
  getCandidate,
  getCandidateStoreBackend,
  getCandidatesBySession,
  getCandidatesByTerm,
  type StoredCandidate,
} from "@/lib/candidate-store";

// candidate-store 回归：a) append + 按 session 查（created_at 升序）b) 幂等（同主键覆盖）
// c) term LIKE 子串查询（ASCII 大小写不敏感 + 中文子串）d) card_id 反查 e) countCandidates
// f) JSONL 降级实现跑同一用例（子进程 CUEMIND_CANDIDATE_STORE=jsonl）。
// 数据目录可被 CUEMIND_DATA_DIR 覆盖（需在首次使用前设置，candidate-store 懒初始化）；
// 与 session-store / chat-store 共用 cuemind.db，故测试目录必须独立。

if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-candidate-test-"));
}
const DATA_DIR = path.resolve(process.env.CUEMIND_DATA_DIR);

function candidate(
  overrides: Partial<StoredCandidate> & Pick<StoredCandidate, "candidateId" | "createdAt">,
): StoredCandidate {
  return {
    sessionId: "sess-main",
    term: null,
    finalState: "card_shown",
    suppressReason: null,
    cardId: null,
    ...overrides,
  };
}

function runSuite(): void {
  const backend = getCandidateStoreBackend();
  console.log(`candidate-store backend = ${backend} (data dir: ${DATA_DIR})`);
  // 强制 JSONL（子进程场景）时后端必须是 jsonl。
  if (process.env.CUEMIND_CANDIDATE_STORE?.trim().toLowerCase() === "jsonl") {
    assert.equal(backend, "jsonl", "强制 jsonl 时后端必须是 jsonl");
  }

  // a) 批量 append（乱序 createdAt）→ getBySession 按 created_at 升序
  appendCandidates([
    candidate({ candidateId: "cand-b", createdAt: "2026-08-28T10:05:00.000Z", term: "speculative decoding", cardId: "card-b" }),
    candidate({ candidateId: "cand-a", createdAt: "2026-08-28T10:00:00.000Z", term: "KV Cache", cardId: "card-a" }),
    candidate({ candidateId: "cand-c", createdAt: "2026-08-28T10:10:00.000Z", finalState: "model_skip" }),
  ]);
  const bySession = getCandidatesBySession("sess-main");
  assert.deepEqual(
    bySession.map((row) => row.candidateId),
    ["cand-a", "cand-b", "cand-c"],
    "getBySession 必须按 created_at 升序",
  );
  assert.equal(bySession[1].term, "speculative decoding");
  assert.equal(bySession[1].cardId, "card-b");

  // b) 幂等：同 (sessionId, candidateId) 覆盖为最新，不新增行（整行 REPLACE：
  //    未显式携带的列也会被新值覆盖，因此保留 term 以便后续 term 查询用例复用）。
  appendCandidates([
    candidate({ candidateId: "cand-b", createdAt: "2026-08-28T11:00:00.000Z", term: "speculative decoding", finalState: "search_failed", suppressReason: "Tavily returned HTTP 401" }),
  ]);
  const afterOverwrite = getCandidatesBySession("sess-main");
  assert.equal(afterOverwrite.length, 3, "同主键覆盖不产生重复行");
  const overwritten = afterOverwrite.find((row) => row.candidateId === "cand-b");
  assert.ok(overwritten);
  assert.equal(overwritten.finalState, "search_failed");
  assert.equal(overwritten.suppressReason, "Tavily returned HTTP 401");
  assert.equal(overwritten.cardId, null, "覆盖后 card_id 取最新值");
  // 覆盖改变了 createdAt → 升序重排到末尾
  assert.deepEqual(
    afterOverwrite.map((row) => row.candidateId),
    ["cand-a", "cand-c", "cand-b"],
  );

  // 多会话隔离 + miss → []
  appendCandidates([
    candidate({ sessionId: "sess-other", candidateId: "cand-x", createdAt: "2026-08-28T09:00:00.000Z" }),
  ]);
  assert.equal(getCandidatesBySession("sess-other").length, 1);
  assert.equal(getCandidatesBySession("sess-other")[0].candidateId, "cand-x");
  assert.deepEqual(getCandidatesBySession("sess-missing"), []);

  // c) term LIKE 子串：ASCII 大小写不敏感 + 中文子串；空 query → []
  assert.deepEqual(
    getCandidatesByTerm("cache").map((row) => row.candidateId),
    ["cand-a"],
  );
  assert.deepEqual(
    getCandidatesByTerm("KV CACHE").map((row) => row.candidateId),
    ["cand-a"],
    "term 查询对 ASCII 大小写不敏感",
  );
  assert.ok(getCandidatesByTerm("DECODING").some((row) => row.candidateId === "cand-b"));
  appendCandidates([
    candidate({ candidateId: "cand-zh", createdAt: "2026-08-28T10:15:00.000Z", term: "推理优化" }),
  ]);
  assert.ok(getCandidatesByTerm("理优").some((row) => row.candidateId === "cand-zh"), "中文子串命中");
  assert.equal(getCandidatesByTerm("不存在的词").length, 0);
  assert.deepEqual(getCandidatesByTerm(""), [], "空 query 返回 []");
  assert.deepEqual(getCandidatesByTerm("   "), [], "空白 query 返回 []");

  // d) card_id 反查（get_card 起源会话追踪）
  const cardHit = getCandidate("card-a");
  assert.ok(cardHit);
  assert.equal(cardHit.candidateId, "cand-a");
  assert.equal(cardHit.sessionId, "sess-main");
  assert.equal(cardHit.finalState, "card_shown");
  assert.equal(getCandidate("card-missing"), null);

  // e) countCandidates：sess-main 4 行（a/b/c + cand-zh）+ sess-other 1 行
  assert.equal(countCandidates(), 5, "countCandidates 只读统计（去重后）");

  console.log(`candidate-store suite passed (${backend})`);
}

// f) 子进程以 JSONL 降级实现重跑同一用例（candidate-store 单例缓存 → 必须隔离进程；
//    独立 CUEMIND_DATA_DIR 避免污染主测试目录的 cuemind.db / candidates.jsonl）
function runJsonlChildSuite(): void {
  const scriptPath = path.resolve(process.argv[1] ?? "scripts/test-candidate-store.ts");
  const repoRoot = path.resolve(scriptPath, "..", "..");
  const loaderArgs = process.execArgv.length > 0 ? [...process.execArgv] : ["--import", "tsx"];
  const result = spawnSync(process.execPath, [...loaderArgs, scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CUEMIND_CANDIDATE_STORE: "jsonl",
      CUEMIND_DATA_DIR: path.join(DATA_DIR, "jsonl-child"),
    },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  assert.equal(result.status, 0, "JSONL 降级实现测试失败");
  console.log("candidate-store JSONL fallback suite passed (child process)");
}

function main(): void {
  runSuite();
  const isForcedJsonl = process.env.CUEMIND_CANDIDATE_STORE?.trim().toLowerCase() === "jsonl";
  if (!isForcedJsonl) runJsonlChildSuite();
  console.log("candidate-store regression tests passed");
}

main();
