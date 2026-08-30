import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

type Segment = { offsets?: { from?: number; to?: number }; text?: string };
type CardResult = { card?: { keyword?: string; keyPoints?: string[]; whyNow?: string }; trace?: { finalState?: string; verticalHit?: boolean }; failure?: { reason?: string } };
type AskResult = { finalState: string; cacheHit?: boolean; stages?: Record<string, number>; answer?: string };

const root = resolve(process.env.CUEMIND_ROOT ?? process.cwd());
const transcriptDir = resolve(process.env.VIDEO_TRANSCRIPT_DIR ?? join(root, "reports/video-reimport-20260830-cuda/transcripts"));
const outputDir = resolve(process.env.VIDEO_LINEAGE_OUTPUT_DIR ?? join(root, "reports/video-card-lineage-20260830"));
const baseUrl = process.env.CUEMIND_BASE_URL ?? "http://localhost:3000";
const model = process.env.LLAMA_CPP_MODEL?.trim() || "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf";
const settings = {
  modelProvider: "llama.cpp",
  llamaCppBaseUrl: process.env.LLAMA_CPP_BASE_URL?.trim() || "http://127.0.0.1:8082",
  llamaCppModel: model,
  llamaCppApiKey: "",
  remoteApiBaseUrl: "", remoteApiModel: "", remoteApiApiKey: "",
  searchProvider: "tavily", searchApiKey: process.env.TAVILY_API_KEY?.trim() || "",
  enableAgentReachFallback: true,
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`${path} returned HTTP ${response.status} with non-JSON body`); }
}

async function ask(question: string, termHint: string): Promise<AskResult> {
  const response = await fetch(`${baseUrl}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, recentTranscript: "", termHint }), signal: AbortSignal.timeout(60_000) });
  if (!response.body) throw new Error(`ask HTTP ${response.status} without body`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; const result: AskResult = { finalState: "no_done" };
  const line = (raw: string) => { const trimmed = raw.trim(); if (!trimmed.startsWith("data:")) return; const payload = trimmed.slice(5).trim(); if (payload === "[DONE]") return; try { const data = JSON.parse(payload) as Record<string, unknown>; if (typeof data.finalState === "string") result.finalState = data.finalState; if (typeof data.cacheHit === "boolean") result.cacheHit = data.cacheHit; if (typeof data.answer === "string") result.answer = data.answer; if (data.stages && typeof data.stages === "object") result.stages = data.stages as Record<string, number>; } catch { /* ignore malformed SSE */ } };
  while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let i = buffer.indexOf("\n"); while (i >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); i = buffer.indexOf("\n"); } }
  line(buffer); return result;
}

async function main(): Promise<void> {
  const files = (await readdir(transcriptDir)).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no transcript JSON in ${transcriptDir}`);
  await mkdir(outputDir, { recursive: true });
  const lineage: Record<string, unknown>[] = [];
  for (const file of files) {
    const payload = JSON.parse(await readFile(join(transcriptDir, file), "utf8")) as { transcription?: Segment[] };
    const segments = (payload.transcription ?? []).filter((segment) => typeof segment.text === "string" && segment.text.trim());
    const picks = segments.length <= 5 ? segments : [0, 0.25, 0.5, 0.75, 0.99].map((ratio) => segments[Math.min(segments.length - 1, Math.floor(ratio * segments.length))]);
    for (let index = 0; index < picks.length; index += 1) {
      const segment = picks[index]; const startMs = segment.offsets?.from ?? 0; const endMs = segment.offsets?.to ?? startMs + 30_000; const id = `${basename(file, ".json")}-${String(index + 1).padStart(2, "0")}`; const transcript = segment.text!.trim();
      const card = await postJson<CardResult>("/api/context-cards", { candidateId: `video-${id}`, datasetVersion: "video-reimport-20260830-cuda", windowingVersion: "asr-30s-sample-v1", coreStartMs: startMs, coreEndMs: endMs, contextStartMs: startMs, contextEndMs: endMs, recentTranscript: transcript, knownKeywords: [], transcriptChunkIds: [`${id}-segment`], settings });
      const keyword = card.card?.keyword?.trim() || null;
      const record: Record<string, unknown> = { id, sourceVideo: file, segment: { startMs, endMs, text: transcript }, card: { finalState: card.trace?.finalState ?? "unknown", keyword, verticalHit: card.trace?.verticalHit ?? null, failure: card.failure?.reason ?? null } };
      if (keyword && card.trace?.finalState === "card_shown") {
        const askQuestion = `What is ${keyword}, and why is it relevant to this discussion?`;
        try { record.ask = { question: askQuestion, ...(await ask(askQuestion, keyword)) }; } catch (error) { record.ask = { question: askQuestion, finalState: "fetch_error", error: error instanceof Error ? error.message : String(error) }; }
      }
      lineage.push(record); process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }
  await writeFile(join(outputDir, "lineage.jsonl"), lineage.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  await writeFile(join(outputDir, "manifest.json"), JSON.stringify({ evaluator: "video-card-lineage-v1", generatedAt: new Date().toISOString(), transcriptDir, baseUrl, videoCount: files.length, windowCount: lineage.length, source: "CUDA whisper.cpp transcript JSON", evidenceBoundary: "Representative 5-window sample per video; cards and asks use live APIs; no claim of full-window card coverage." }, null, 2) + "\n", "utf8");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
