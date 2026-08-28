// 供 Next 前端与 scripts 单测使用的共享出口；单一实现在
// desktop/electron/audio-source-mode.ts（Electron desktop:compile 的 rootDir 限制所致）。
export type { AudioSourceMode } from "../desktop/electron/audio-source-mode";
export {
  AUDIO_SOURCE_MODE_LABELS,
  AUDIO_SOURCE_MODES,
  normalizeAudioSourceMode,
  serializeAudioSourceArgs,
} from "../desktop/electron/audio-source-mode";
