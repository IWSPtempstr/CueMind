import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopRuntimeStatus } from "./types";

const bridge: DesktopBridge = {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:get-status") as Promise<DesktopRuntimeStatus>,
  startAudioHelper: () => ipcRenderer.invoke("runtime:start-audio-helper") as Promise<DesktopRuntimeStatus>,
  stopAudioHelper: () => ipcRenderer.invoke("runtime:stop-audio-helper") as Promise<DesktopRuntimeStatus>,
  setAudioSourceMode: (mode) => ipcRenderer.invoke("runtime:set-audio-source-mode", mode) as Promise<DesktopRuntimeStatus>,
  onRuntimeEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      if (typeof raw === "string") listener(raw);
    };
    ipcRenderer.on("desktop:event", handler);
    return () => ipcRenderer.removeListener("desktop:event", handler);
  },
};

contextBridge.exposeInMainWorld("cuemindDesktop", bridge);
