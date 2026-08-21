import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Readable } from "node:stream";
import type { DesktopRuntimeStatus } from "./types";

const currentDir = __dirname;

let mainWindow: BrowserWindow | null = null;
type AudioHelperProcess = ChildProcessByStdio<null, Readable, Readable>;
let audioHelper: AudioHelperProcess | null = null;
let lastError: string | null = null;
let audioOutputDir: string | null = null;

function runtimeStatus(): DesktopRuntimeStatus {
  return {
    helperRunning: audioHelper !== null && audioHelper.exitCode === null,
    audioOutputDir,
    lastError,
  };
}

function helperPath(): string {
  const configuredPath = process.env.CUEMIND_AUDIO_HELPER;
  if (configuredPath) return configuredPath;

  if (app.isPackaged) {
    return path.join(process.resourcesPath, "CueMind.Audio", "CueMind.Audio.exe");
  }

  return path.resolve(currentDir, "../../native/CueMind.Audio/bin/Release/net8.0-windows/win-x64/publish/CueMind.Audio.exe");
}

async function startAudioHelper(): Promise<DesktopRuntimeStatus> {
  if (audioHelper && audioHelper.exitCode === null) return runtimeStatus();
  if (process.platform !== "win32") {
    lastError = "CueMind.Audio requires Windows 10 22H2 or Windows 11 x64.";
    return runtimeStatus();
  }

  audioOutputDir = path.join(app.getPath("userData"), "audio");
  await mkdir(audioOutputDir, { recursive: true });
  lastError = null;

  const child = spawn(helperPath(), [audioOutputDir], {
    cwd: path.dirname(helperPath()),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  audioHelper = child;

  const stdoutLines = createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    process.stdout.write(`[CueMind.Audio] ${line}\n`);
  });

  const stderrLines = createInterface({ input: child.stderr });
  stderrLines.on("line", (line) => {
    process.stderr.write(`[CueMind.Audio] ${line}\n`);
  });

  child.once("error", (error) => {
    lastError = `Audio helper failed to start: ${error.message}`;
    audioHelper = null;
    mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  });

  child.once("exit", (code, signal) => {
    if (audioHelper === child) audioHelper = null;
    if (code !== 0 && signal !== "SIGTERM") {
      lastError = `Audio helper exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}).`;
    }
    mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  });

  mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  return runtimeStatus();
}

async function stopAudioHelper(): Promise<DesktopRuntimeStatus> {
  const child = audioHelper;
  if (!child || child.exitCode !== null) {
    audioHelper = null;
    return runtimeStatus();
  }

  child.kill();
  audioHelper = null;
  mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  return runtimeStatus();
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(currentDir, "preload.js"),
    },
  });

  const uiUrl = process.env.CUEMIND_UI_URL ?? "http://localhost:3000";
  await mainWindow.loadURL(uiUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("runtime:get-status", () => runtimeStatus());
ipcMain.handle("runtime:start-audio-helper", () => startAudioHelper());
ipcMain.handle("runtime:stop-audio-helper", () => stopAudioHelper());

app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => {
  void stopAudioHelper();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
