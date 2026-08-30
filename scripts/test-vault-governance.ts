import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveVaultEntry,
  createVaultEntry,
  getVaultEntry,
  getVaultVersion,
  searchVaultEntries,
  withdrawVaultEntry,
} from "@/lib/vault-governance";

const root = mkdtempSync(path.join(tmpdir(), "cuemind-governance-test-"));

function run(): void {
  const created = createVaultEntry(root, {
    entryId: "entry-1",
    title: "KV cache",
    body: "复用键值对可降低重复计算。",
    sourceUrl: "https://example.test/kv",
    sourceType: "official",
    actor: "system",
  });
  assert.equal(created.version, 1);
  assert.equal(created.status, "active");
  assert.equal(created.sourceLevel, "official");

  const risky = createVaultEntry(root, {
    entryId: "entry-1",
    title: "KV cache 更新",
    body: "改变既有行动建议。",
    sourceUrl: "https://example.test/new",
    sourceType: "community",
    highRisk: true,
    conflictId: "conflict-1",
    actor: "system",
  });
  assert.equal(risky.version, 2);
  assert.equal(risky.status, "needs_review");
  assert.equal(getVaultEntry(root, "entry-1")?.currentVersion, 1);
  assert.equal(searchVaultEntries(root, "行动建议").length, 0);
  assert.equal(getVaultVersion(root, "entry-1", 2)?.status, "needs_review");

  const approved = approveVaultEntry(root, "entry-1", 2, "reviewer");
  assert.equal(approved.status, "active");
  assert.equal(getVaultEntry(root, "entry-1")?.currentVersion, 2);
  assert.equal(searchVaultEntries(root, "KV").length, 1);

  const withdrawn = withdrawVaultEntry(root, "entry-1", "reviewer");
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(searchVaultEntries(root, "KV").length, 0);
  assert.equal(getVaultVersion(root, "entry-1", 1)?.status, "superseded");

  console.log("vault governance tests passed");
}

run();
