import { readFile, writeFile } from "node:fs/promises";
import { generateLlamaCppJson } from "@/lib/llama-cpp";
import {
  ModelProviderError,
  serializeModelProviderError,
} from "@/lib/model-provider";

// The smoke reads the first fixed 60-second transcript window and asks the local
// provider for one keyword. It is evidence for local structured-output only, not
// search, card quality, or end-to-end readiness.
const WINDOW_MS = 60_000;
const MAX_INPUT_CHARS = 12_000;
const TIMEOUT_MS = 120_000;

interface SmokeReport {
  provider: "llama.cpp";
  model: string;
  baseUrl: string;
  inputWindowMs: [number, number];
  inputChars: number;
  inputSegments: number;
  latencyMs: number;
  output: { keyword: string } | null;
  error: {
    code: string;
    provider?: string;
    status?: number;
    message?: string;
  } | null;
  generatedAt: string;
  evidenceBoundary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

interface WindowResult {
  text: string;
  segmentCount: number;
  startMs: number;
  endMs: number;
}

function extractWindow(raw: string): WindowResult {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Transcript JSON is not an object");

  const transcription = parsed.transcription;
  if (!Array.isArray(transcription)) {
    const fallback = typeof parsed.text === "string"
      ? parsed.text
      : isRecord(parsed.result) && typeof parsed.result.text === "string"
        ? parsed.result.text
        : "";
    if (!fallback.trim()) throw new Error("Transcript JSON has no transcription array");
    return {
      text: fallback.slice(0, MAX_INPUT_CHARS),
      segmentCount: 0,
      startMs: 0,
      endMs: WINDOW_MS,
    };
  }

  const parts: string[] = [];
  let startMs = 0;
  let endMs = 0;
  let saw = false;

  for (const item of transcription) {
    if (!isRecord(item)) continue;
    const from = isRecord(item.offsets) && typeof item.offsets.from === "number"
      ? item.offsets.from
      : 0;
    const to = isRecord(item.offsets) && typeof item.offsets.to === "number"
      ? item.offsets.to
      : from;
    if (from >= WINDOW_MS) continue;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    parts.push(text);
    if (!saw) {
      startMs = from;
      saw = true;
    }
    endMs = to;
  }

  if (parts.length === 0) throw new Error("No transcript text in the first 60s window");
  return { text: parts.join("\n").slice(0, MAX_INPUT_CHARS), segmentCount: parts.length, startMs, endMs };
}

async function writeReport(outputPath: string, report: SmokeReport): Promise<void> {
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const [baseUrl, model, transcriptPath, outputPath] = process.argv.slice(2);
  if (!baseUrl || !model || !transcriptPath || !outputPath) {
    console.error("usage: run-local-model-smoke.ts <baseUrl> <model> <transcriptJson> <outputJson>");
    process.exitCode = 1;
    return;
  }

  let inputText = "";
  let segmentCount = 0;
  let startMs = 0;
  let endMs = 0;

  try {
    const raw = await readFile(transcriptPath, "utf8");
    const window = extractWindow(raw);
    inputText = window.text;
    segmentCount = window.segmentCount;
    startMs = window.startMs;
    endMs = window.endMs;
  } catch (caught) {
    await writeReport(outputPath, {
      provider: "llama.cpp",
      model,
      baseUrl,
      inputWindowMs: [0, WINDOW_MS],
      inputChars: 0,
      inputSegments: 0,
      latencyMs: 0,
      output: null,
      error: { code: "invalid_transcript", message: messageOf(caught) },
      generatedAt: new Date().toISOString(),
      evidenceBoundary: "local model structured output only",
    });
    console.error(caught);
    process.exitCode = 1;
    return;
  }

  const keywordStarted = Date.now();
  try {
    const result = await generateLlamaCppJson<{ keyword: string }>({
      baseUrl,
      model,
      system: "从技术会议转写中识别一个此刻最值得补充背景的具体技术关键词。只返回 JSON：{\"keyword\":\"...\"}。不要返回泛化词。",
      prompt: `最近转写：\n${inputText}`,
      timeoutMs: TIMEOUT_MS,
    });
    const latencyMs = Date.now() - keywordStarted;
    const keyword = typeof result.keyword === "string" ? result.keyword.trim() : "";

    if (!keyword) {
      await writeReport(outputPath, {
        provider: "llama.cpp",
        model,
        baseUrl,
        inputWindowMs: [startMs, endMs],
        inputChars: inputText.length,
        inputSegments: segmentCount,
        latencyMs,
        output: null,
        error: { code: "model_schema_invalid", message: "keyword field missing or empty" },
        generatedAt: new Date().toISOString(),
        evidenceBoundary: "local model structured output only",
      });
      console.error("Local provider returned JSON without a non-empty keyword.");
      process.exitCode = 1;
      return;
    }

    await writeReport(outputPath, {
      provider: "llama.cpp",
      model,
      baseUrl,
      inputWindowMs: [startMs, endMs],
      inputChars: inputText.length,
      inputSegments: segmentCount,
      latencyMs,
      output: { keyword },
      error: null,
      generatedAt: new Date().toISOString(),
      evidenceBoundary: "local model structured output only",
    });
    console.log("local model smoke passed");
  } catch (caught) {
    const latencyMs = Date.now() - keywordStarted;
    const error = caught instanceof ModelProviderError
      ? {
          code: caught.code,
          provider: caught.provider,
          status: caught.status,
          message: serializeModelProviderError(caught).message,
        }
      : { code: "unexpected", message: messageOf(caught) };

    await writeReport(outputPath, {
      provider: "llama.cpp",
      model,
      baseUrl,
      inputWindowMs: [startMs, endMs],
      inputChars: inputText.length,
      inputSegments: segmentCount,
      latencyMs,
      output: null,
      error,
      generatedAt: new Date().toISOString(),
      evidenceBoundary: "local model structured output only",
    });
    console.error(caught);
    process.exitCode = 1;
  }
}

main();
