import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const BASELINE_MATRIX = [
  { model: "4B", quantization: "Q4_K_M", kvCache: true, gpuLayers: 0 },
  { model: "4B", quantization: "Q8_0", kvCache: true, gpuLayers: 0 },
  { model: "8B", quantization: "Q4_K_M", kvCache: true, gpuLayers: 0 },
  { model: "8B", quantization: "Q8_0", kvCache: true, gpuLayers: 0 },
];

export function writeBaselineManifest(outDir: string, metadata: Record<string, unknown> = {}): string {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "model-baseline-manifest.json");
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), matrix: BASELINE_MATRIX, ...metadata }, null, 2)}\n`, "utf8");
  return file;
}

if (process.argv[1]?.endsWith("model-baseline-matrix.ts")) {
  const out = process.argv[2] ?? path.join(process.cwd(), "reports", "model-baseline");
  console.log(writeBaselineManifest(out, { note: "Run each row with fixed hardware/model/runtime and append measured quality, tok/s, memory, TTFT and P95." }));
}
