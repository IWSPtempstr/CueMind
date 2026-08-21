/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cuemindDesktop", {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:get-status"),
  startAudioHelper: () => ipcRenderer.invoke("runtime:start-audio-helper"),
  stopAudioHelper: () => ipcRenderer.invoke("runtime:stop-audio-helper"),
  onRuntimeEvent: (listener) => {
    const handler = (_event, raw) => {
      if (typeof raw === "string") listener(raw);
    };
    ipcRenderer.on("desktop:event", handler);
    return () => ipcRenderer.removeListener("desktop:event", handler);
  },
});
