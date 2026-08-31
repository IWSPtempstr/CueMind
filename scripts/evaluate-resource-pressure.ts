import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.ASK_MEASURE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outputDir = path.resolve(process.env.RESOURCE_PRESSURE_OUTPUT ?? path.join(process.cwd(), "reports", "performance-resilience", `pressure-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const maxConcurrency = Math.min(4, Math.max(1, Number(process.env.RESOURCE_PRESSURE_MAX_CONCURRENCY ?? 4)));
const sampleIntervalMs = 300;
const askQuestions = ["KV Cache 是什么？", "RAG 的基本流程是什么？", "什么是 PagedAttention？", "什么是 speculative decoding？"];

interface ResourceSample { atMs: number; gpu: { utilizationPercent: number | null; memoryUsedMiB: number | null; memoryTotalMiB: number | null } | null; processRssBytes: number }
interface AskResult { status: string; elapsedMs: number; error?: string }

async function readGpu(): Promise<ResourceSample["gpu"]> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 2_000 });
    const [utilization, used, total] = stdout.trim().split(",").map((value) => Number(value.trim()));
    if (![utilization, used, total].every(Number.isFinite)) return null;
    return { utilizationPercent: utilization, memoryUsedMiB: used, memoryTotalMiB: total };
  } catch { return null; }
}

async function ask(question: string): Promise<AskResult> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, recentTranscript: "本地资源压力测评，仅用于验证超时和恢复。" }), signal: AbortSignal.timeout(45_000) });
    if (!response.ok || !response.body) return { status: `http_${response.status}`, elapsedMs: performance.now() - started };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let status = "stream_closed";
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const raw = trimmed.slice(5).trim();
      if (raw === "[DONE]") return;
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        if (payload.event === "done" && typeof payload.finalState === "string") status = payload.finalState;
      } catch { /* Ignore non-JSON SSE lines. */ }
    };
    while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let split = buffer.indexOf("\n\n"); while (split !== -1) { for (const line of buffer.slice(0, split).split("\n")) consume(line); buffer = buffer.slice(split + 2); split = buffer.indexOf("\n\n"); } }
    for (const line of buffer.split("\n")) consume(line);
    return { status, elapsedMs: performance.now() - started };
  } catch (error) { return { status: "timeout_or_network_error", elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) }; }
}

async function runTier(concurrency: number): Promise<Record<string, unknown>> {
  const started = performance.now();
  const samples: ResourceSample[] = [];
  let sampling = true;
  const sampler = (async () => { while (sampling) { samples.push({ atMs: performance.now() - started, gpu: await readGpu(), processRssBytes: process.memoryUsage().rss }); await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs)); } })();
  const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => ask(askQuestions[index % askQuestions.length])));
  sampling = false;
  await sampler;
  let recovery = "not_checked";
  try {
    const appResponse = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
    const llamaResponse = await fetch("http://127.0.0.1:8082/health", { signal: AbortSignal.timeout(5_000) });
    recovery = appResponse.ok && llamaResponse.ok ? "app_and_llama_health_ok" : `app_${appResponse.status}_llama_${llamaResponse.status}`;
  } catch { recovery = "health_unreachable"; }
  return { concurrency, elapsedMs: performance.now() - started, results, resourceSamples: samples, recovery, destructiveOomTest: false };
}

async function main(): Promise<void> {
  const tiers: Array<Record<string, unknown>> = [];
  for (const concurrency of [1, 2, 4]) { if (concurrency > maxConcurrency) break; const tier = await runTier(concurrency); tiers.push(tier); const results = tier.results as AskResult[]; if (results.some((result) => result.status === "timeout_or_network_error")) break; }
  const failures = tiers.flatMap((tier) => (tier.results as AskResult[]).filter((result) => result.status === "timeout_or_network_error" || result.status.startsWith("http_")));
  const manifest = { evaluator: "resource-pressure-evaluator-v1", generatedAt: new Date().toISOString(), baseUrl, tiers: tiers.map((tier) => tier.concurrency), sampleIntervalMs, executionMode: "real_controlled_concurrency", destructiveOomTest: false, evidenceBoundary: "Controlled short-duration request concurrency and local nvidia-smi/process observations. This is not an artificial OOM or sustained production load test." };
  const scorecard = { evaluator: manifest.evaluator, status: failures.length === 0 && tiers.length > 0 ? "complete" : "partial", denominator: { tiers: tiers.length, requests: tiers.reduce((sum, tier) => sum + (tier.results as AskResult[]).length, 0), failures: failures.length }, recovery: tiers.map((tier) => ({ concurrency: tier.concurrency, status: tier.recovery })), evidenceBoundary: manifest.evidenceBoundary };
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "cases.jsonl"), tiers.flatMap((tier) => (tier.results as AskResult[]).map((result, index) => JSON.stringify({ concurrency: tier.concurrency, index, ...result }))).join("\n") + "\n"),
    writeFile(path.join(outputDir, "failures.jsonl"), failures.map((result) => JSON.stringify(result)).join("\n") + (failures.length ? "\n" : "")),
    writeFile(path.join(outputDir, "resource-samples.jsonl"), tiers.flatMap((tier) => (tier.resourceSamples as ResourceSample[]).map((sample) => JSON.stringify({ concurrency: tier.concurrency, ...sample }))).join("\n") + "\n"),
    writeFile(path.join(outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`),
    writeFile(path.join(outputDir, "report.md"), `# Resource pressure and recovery report\n\n- Status: ${scorecard.status}\n- Tiers: ${tiers.map((tier) => tier.concurrency).join(", ")} concurrent requests\n- Request failures: ${failures.length}\n- Recovery: ${JSON.stringify(scorecard.recovery)}\n- Destructive OOM test: false\n- Evidence: ${manifest.evidenceBoundary}\n`),
  ]);
  console.log(`Resource pressure report written to ${outputDir}`);
  if (scorecard.status !== "complete") process.exitCode = 1;
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
