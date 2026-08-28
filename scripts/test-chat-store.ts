import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendChatMessages,
  getChatMessages,
  getChatStoreBackend,
  hasChatMessages,
  type StoredChatMessage,
} from "@/lib/chat-store";

// chat-store 回归：a) 往返与升序 b) 幂等 upsert c) 会话隔离 d) 空查询 e) hasChatMessages
// f) JSONL 降级实现跑同一用例（子进程 CUEMIND_CHAT_STORE=jsonl）。
// 数据目录可被 CUEMIND_DATA_DIR 覆盖（需在首次使用前设置，chat-store 懒初始化）。

if (!process.env.CUEMIND_DATA_DIR?.trim()) {
  process.env.CUEMIND_DATA_DIR = mkdtempSync(path.join(tmpdir(), "cuemind-chat-test-"));
}
const DATA_DIR = path.resolve(process.env.CUEMIND_DATA_DIR);

let seq = 0;
function message(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  seq += 1;
  return {
    id: overrides.id ?? `m-${seq}`,
    sessionId: overrides.sessionId ?? "session-main",
    role: overrides.role ?? "user",
    content: overrides.content ?? `内容 ${seq}`,
    isDetail: overrides.isDetail ?? false,
    createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 7, 27, 10, 0, seq)).toISOString(),
  };
}

function runSuite(): void {
  const backend = getChatStoreBackend();
  console.log(`chat-store backend = ${backend} (data dir: ${DATA_DIR})`);

  // a) append + get 往返：乱序 createdAt 写入 → 读取按 createdAt 升序
  const rt1 = message({ id: "rt-1", role: "assistant", content: "assistant 回复", createdAt: "2026-08-27T10:00:05.000Z" });
  const rt2 = message({ id: "rt-2", role: "user", content: "user 提问", createdAt: "2026-08-27T10:00:00.000Z" });
  const rt3 = message({ id: "rt-3", role: "assistant", content: "细节补充", isDetail: true, createdAt: "2026-08-27T10:00:10.000Z" });
  appendChatMessages([rt2, rt3, rt1]); // 故意乱序写入
  const roundtrip = getChatMessages("session-main");
  assert.deepEqual(roundtrip.map((m) => m.id), ["rt-2", "rt-1", "rt-3"]);
  assert.equal(roundtrip[0].content, "user 提问");
  assert.equal(roundtrip[0].role, "user");
  assert.equal(roundtrip[1].content, "assistant 回复");
  assert.equal(roundtrip[2].isDetail, true);
  assert.equal(roundtrip[0].isDetail, false);

  // b) 幂等 upsert：同 id 重复写不产生重复行，内容取最后一条
  appendChatMessages([rt1, rt2, rt3]); // 原样重复写
  const afterRepeat = getChatMessages("session-main");
  assert.equal(afterRepeat.length, 3);
  assert.equal(afterRepeat.find((m) => m.id === "rt-1")?.content, "assistant 回复");
  appendChatMessages([message({ id: "rt-1", role: "assistant", content: "更新后的回复", createdAt: "2026-08-27T10:00:05.000Z" })]);
  const afterUpsert = getChatMessages("session-main");
  assert.equal(afterUpsert.length, 3);
  assert.equal(afterUpsert.find((m) => m.id === "rt-1")?.content, "更新后的回复");

  // c) 会话隔离：sessionA/B 互不可见
  appendChatMessages([message({ id: "iso-a", sessionId: "session-a", content: "A 的消息" })]);
  appendChatMessages([message({ id: "iso-b", sessionId: "session-b", content: "B 的消息" })]);
  const sessionA = getChatMessages("session-a");
  const sessionB = getChatMessages("session-b");
  assert.equal(sessionA.length, 1);
  assert.equal(sessionA[0].id, "iso-a");
  assert.equal(sessionA[0].content, "A 的消息");
  assert.equal(sessionB.length, 1);
  assert.equal(sessionB[0].id, "iso-b");

  // d) 空查询返回 []
  assert.deepEqual(getChatMessages("session-missing"), []);

  // e) hasChatMessages 正确
  assert.equal(hasChatMessages("session-main"), true);
  assert.equal(hasChatMessages("session-a"), true);
  assert.equal(hasChatMessages("session-missing"), false);

  console.log(`chat-store suite passed (${backend})`);
}

// f) 子进程以 JSONL 降级实现重跑同一用例（chat-store 单例缓存 → 必须隔离进程）
function runJsonlChildSuite(): void {
  const scriptPath = path.resolve(process.argv[1] ?? "scripts/test-chat-store.ts");
  const repoRoot = path.resolve(scriptPath, "..", "..");
  const loaderArgs = process.execArgv.length > 0 ? [...process.execArgv] : ["--import", "tsx"];
  const result = spawnSync(process.execPath, [...loaderArgs, scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CUEMIND_CHAT_STORE: "jsonl",
      CUEMIND_DATA_DIR: path.join(DATA_DIR, "jsonl-child"),
    },
    stdio: "inherit",
  });
  if (result.error) console.error(result.error);
  assert.equal(result.status, 0, "JSONL 降级实现测试失败");
  console.log("chat-store JSONL fallback suite passed (child process)");
}

function main(): void {
  runSuite();
  const isForcedJsonl = process.env.CUEMIND_CHAT_STORE?.trim().toLowerCase() === "jsonl";
  if (!isForcedJsonl) runJsonlChildSuite();
  console.log("chat-store regression tests passed");
}

main();
