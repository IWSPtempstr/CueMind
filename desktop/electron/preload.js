/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cuemindDesktop", {
  getRuntimeStatus: () => ipcRenderer.invoke("runtime:get-status"),
  startAudioHelper: () => ipcRenderer.invoke("runtime:start-audio-helper"),
  stopAudioHelper: () => ipcRenderer.invoke("runtime:stop-audio-helper"),
});
