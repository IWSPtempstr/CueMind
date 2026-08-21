export interface DesktopRuntimeStatus {
  helperRunning: boolean;
  audioOutputDir: string | null;
  lastError: string | null;
}

export interface DesktopBridge {
  getRuntimeStatus: () => Promise<DesktopRuntimeStatus>;
  startAudioHelper: () => Promise<DesktopRuntimeStatus>;
  stopAudioHelper: () => Promise<DesktopRuntimeStatus>;
}
