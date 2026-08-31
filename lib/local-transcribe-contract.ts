export interface LocalTranscribeBody {
  runId: string;
  audioPath: string;
  source: "system" | "microphone" | "upload";
  startMs: number;
  endMs: number;
  settings: {
    whisperPath: string;
    modelPath: string;
    language: "auto" | "zh" | "en";
    timeoutMs?: number;
    promptContext?: { topic?: string; glossary?: string };
    vad?: { enabled: boolean; modelPath: string };
  };
}

export function parseLocalTranscribeRequest(value: unknown): LocalTranscribeBody | null {
  if (!isRecord(value) || !isString(value.audioPath) || !value.audioPath.trim()) return null;
  if (!isString(value.runId) || !value.runId.trim() || value.runId.length > 160) return null;
  if (value.source !== "system" && value.source !== "microphone" && value.source !== "upload") return null;
  if (!isFiniteNumber(value.startMs) || !isFiniteNumber(value.endMs)) return null;
  if (!isRecord(value.settings)) return null;
  if (!isString(value.settings.whisperPath) || !value.settings.whisperPath.trim()) return null;
  if (!isString(value.settings.modelPath) || !value.settings.modelPath.trim()) return null;
  const language = value.settings.language;
  if (language !== "auto" && language !== "zh" && language !== "en") return null;

  const timeoutMs = value.settings.timeoutMs;
  if (timeoutMs !== undefined && (!isFiniteNumber(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)) return null;
  const promptContext = parsePromptContext(value.settings.promptContext);
  const vad = parseVad(value.settings.vad);
  return {
    runId: value.runId.trim(),
    audioPath: value.audioPath,
    source: value.source,
    startMs: value.startMs,
    endMs: value.endMs,
    settings: {
      whisperPath: value.settings.whisperPath,
      modelPath: value.settings.modelPath,
      language,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(promptContext ? { promptContext } : {}),
      ...(vad ? { vad } : {}),
    },
  };
}

function parsePromptContext(value: unknown): { topic?: string; glossary?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const topic = isString(value.topic) ? value.topic : undefined;
  const glossary = isString(value.glossary) ? value.glossary : undefined;
  if (topic === undefined && glossary === undefined) return undefined;
  return { ...(topic !== undefined ? { topic } : {}), ...(glossary !== undefined ? { glossary } : {}) };
}

function parseVad(value: unknown): { enabled: boolean; modelPath: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.enabled !== "boolean" || !isString(value.modelPath) || !value.modelPath.trim()) return undefined;
  return { enabled: value.enabled, modelPath: value.modelPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
