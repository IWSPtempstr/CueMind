// 桌面输入源模式的单一实现。
// 注意：实现必须位于 desktop/electron 下——Electron 主进程的 tsconfig（desktop:compile）
// 设置了 rootDir，只有本目录内的文件会被打进 dist；lib/audio-source-mode.ts 对此做 re-export
// 供 Next 前端与 scripts 单测共享，避免两端漂移。

export type AudioSourceMode = "mic" | "system" | "mixed";

export const AUDIO_SOURCE_MODES = ["mic", "system", "mixed"] as const;

export const AUDIO_SOURCE_MODE_LABELS: Record<AudioSourceMode, string> = {
  mic: "仅麦克风",
  system: "仅系统声音",
  mixed: "混合采集",
};

// 非法值回落 "mixed"，与 C# helper（Program.cs）的容错一致。
export function normalizeAudioSourceMode(value: unknown): AudioSourceMode {
  return value === "mic" || value === "system" || value === "mixed" ? value : "mixed";
}

// 模式参数 → C# helper 的 argv 片段，例如 ["--sources", "mic"]。
export function serializeAudioSourceArgs(mode: unknown): string[] {
  return ["--sources", normalizeAudioSourceMode(mode)];
}
