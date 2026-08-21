import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopRuntimeStatus } from "./types";

const bridge: DesktopBridge = {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:get-status") as Promise<DesktopRuntimeStatus>,
  startAudioHelper: () => ipcRenderer.invoke("runtime:start-audio-helper") as Promise<DesktopRuntimeStatus>,
  stopAudioHelper: () => ipcRenderer.invoke("runtime:stop-audio-helper") as Promise<DesktopRuntimeStatus>,
};

contextBridge.exposeInMainWorld("cuemindDesktop", bridge);
