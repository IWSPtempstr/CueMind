import path from "node:path";

function configured(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function resolveWhisperPath(): string {
  return configured("CUEMIND_WHISPER_PATH");
}

export function resolveWhisperModelPath(): string {
  return configured("CUEMIND_WHISPER_MODEL_PATH");
}

export function resolveFfmpegPath(): string {
  return configured("CUEMIND_FFMPEG_PATH") || "ffmpeg";
}

export function resolveVadModelPath(): string {
  return configured("CUEMIND_VAD_MODEL_PATH");
}

export function resolveConfiguredVaultPath(): string | undefined {
  const value = configured("CUEMIND_VAULT_DIR");
  return value ? path.resolve(value) : undefined;
}
