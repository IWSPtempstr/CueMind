import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");

await mkdir(path.join(standaloneDir, ".next"), { recursive: true });
await cp(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"), { recursive: true, force: true });

const publicDir = path.join(root, "public");
try {
  await cp(publicDir, path.join(standaloneDir, "public"), { recursive: true, force: true });
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    await rm(path.join(standaloneDir, "public"), { recursive: true, force: true });
  } else {
    throw error;
  }
}

console.log(`Prepared Next standalone server at ${standaloneDir}`);
