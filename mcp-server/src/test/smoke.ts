// 独立包内冒烟测试（纯函数 + db 缺失路径，不依赖外部数据库）。
// stdio 全链路自测由主项目 scripts/test-mcp-server.ts 覆盖。
// 运行：npm run build && node dist/test/smoke.js

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bigramTokens } from "../bigram.js";
import { DbUnavailableError, openReadonlyDb } from "../db.js";

function testBigramTokens(): void {
  // 中文 2-gram：与主项目 bigramTokens 语义一致。
  assert.deepEqual(bigramTokens("中文测试"), ["中文", "文测", "测试"]);
  assert.deepEqual(bigramTokens("知识沉淀"), ["知识", "识沉", "沉淀"]);
  // ASCII 整词 + 小写化。
  assert.deepEqual(bigramTokens("Hello, World!"), ["hello", "world"]);
  // 混合与单字 CJK。
  assert.deepEqual(bigramTokens("混合mix检索"), ["混合", "mix", "检索"]);
  assert.deepEqual(bigramTokens("好"), ["好"]);
  // 纯标点 → 空 token 列表（查询侧返回空结果集的依据）。
  assert.deepEqual(bigramTokens("。！？ -- "), []);
}

function testMissingDbError(): void {
  const emptyDir = mkdtempSync(path.join(tmpdir(), "cuemind-mcp-smoke-"));
  const previous = process.env.CUEMIND_DATA_DIR;
  try {
    process.env.CUEMIND_DATA_DIR = emptyDir;
    assert.throws(
      () => openReadonlyDb(),
      (error: unknown) =>
        error instanceof DbUnavailableError && error.message.includes("cuemind.db not found"),
    );
  } finally {
    if (previous === undefined) delete process.env.CUEMIND_DATA_DIR;
    else process.env.CUEMIND_DATA_DIR = previous;
    rmSync(emptyDir, { recursive: true, force: true });
  }
}

testBigramTokens();
testMissingDbError();
console.log("smoke: all assertions passed");
