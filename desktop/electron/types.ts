import type { AudioSourceMode } from "./audio-source-mode";

export interface DesktopRuntimeStatus {
  helperRunning: boolean;
  audioOutputDir: string | null;
  lastError: string | null;
  audioSourceMode: AudioSourceMode;
}

export interface DesktopBridge {
  getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
  startAudioHelper: () => Promise<DesktopRuntimeStatus>;
  stopAudioHelper: () => Promise<DesktopRuntimeStatus>;
  setAudioSourceMode: (mode: AudioSourceMode) => Promise<DesktopRuntimeStatus>;
  onRuntimeEvent: (listener: (raw: string) => void) => () => void;
}
