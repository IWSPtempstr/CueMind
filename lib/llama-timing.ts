import { percentile } from "@/lib/telemetry";

export interface LlamaTiming {
  promptTokens: number | null;
  outputTokens: number | null;
  promptMs: number | null;
  generationMs: number | null;
  tokensPerSecond: number | null;
}

function numberAt(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

export function extractLlamaTiming(payload: unknown): LlamaTiming | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const timings = (root.timings && typeof root.timings === "object" ? root.timings : root.usage) as Record<string, unknown> | undefined;
  if (!timings) return null;
  const promptTokens = numberAt(timings, ["prompt_n", "prompt_tokens"]);
  const outputTokens = numberAt(timings, ["predicted_n", "completion_tokens", "output_tokens"]);
  const promptMs = numberAt(timings, ["prompt_ms", "prompt_processing_ms"]);
  const generationMs = numberAt(timings, ["predicted_ms", "generation_ms", "completion_ms"]);
  let tokensPerSecond = numberAt(timings, ["predicted_per_second", "tokens_per_second"]);
  if (tokensPerSecond === null && outputTokens !== null && generationMs !== null && generationMs > 0) tokensPerSecond = outputTokens / (generationMs / 1000);
  if ([promptTokens, outputTokens, promptMs, generationMs, tokensPerSecond].every((value) => value === null)) return null;
  return { promptTokens, outputTokens, promptMs, generationMs, tokensPerSecond };
}

export function summarizeLlamaTiming(values: LlamaTiming[]): { count: number; tokensPerSecondP50: number | null; tokensPerSecondP95: number | null; promptMsP50: number | null; generationMsP50: number | null } {
  const tok = values.map((value) => value.tokensPerSecond).filter((value): value is number => value !== null);
  const prompt = values.map((value) => value.promptMs).filter((value): value is number => value !== null);
  const generation = values.map((value) => value.generationMs).filter((value): value is number => value !== null);
  return { count: values.length, tokensPerSecondP50: percentile(tok, 50), tokensPerSecondP95: percentile(tok, 95), promptMsP50: percentile(prompt, 50), generationMsP50: percentile(generation, 50) };
}
