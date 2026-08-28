import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Readable } from "node:stream";
import { normalizeAudioSourceMode, serializeAudioSourceArgs, type AudioSourceMode } from "./audio-source-mode";
import type { DesktopRuntimeStatus } from "./types";

const currentDir = __dirname;

let mainWindow: BrowserWindow | null = null;
type AudioHelperProcess = ChildProcessByStdio<null, Readable, Readable>;
let audioHelper: AudioHelperProcess | null = null;
let uiServer: AudioHelperProcess | null = null;
let lastError: string | null = null;
let audioOutputDir: string | null = null;
let audioSourceMode: AudioSourceMode = "mixed";
const UI_PORT = 4173;

function runtimeStatus(): DesktopRuntimeStatus {
  return {
    helperRunning: audioHelper !== null && audioHelper.exitCode === null,
    audioOutputDir,
    lastError,
    audioSourceMode,
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

async function startAudioHelper(mode?: AudioSourceMode): Promise<DesktopRuntimeStatus> {
  if (mode) audioSourceMode = normalizeAudioSourceMode(mode);
  if (audioHelper && audioHelper.exitCode === null) return runtimeStatus();
  if (process.platform !== "win32") {
    lastError = "CueMind.Audio requires Windows 10 22H2 or Windows 11 x64.";
    return runtimeStatus();
  }

  audioOutputDir = path.join(app.getPath("userData"), "audio");
  await mkdir(audioOutputDir, { recursive: true });
  lastError = null;

  const child = spawn(helperPath(), [audioOutputDir, ...serializeAudioSourceArgs(audioSourceMode)], {
    cwd: path.dirname(helperPath()),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  audioHelper = child;

  const stdoutLines = createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    process.stdout.write(`[CueMind.Audio] ${line}\n`);
    mainWindow?.webContents.send("desktop:event", line);
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
    // 仅当退出的仍是当前 helper 时才视为异常退出；主动 stop/切换模式重启导致的退出
    // （audioHelper 已被置空或换成新 child）不写 lastError。
    if (audioHelper === child) {
      audioHelper = null;
      if (code !== 0 && signal !== "SIGTERM") {
        lastError = `Audio helper exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}).`;
      }
    }
    mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  });

  mainWindow?.webContents.send("runtime:status-changed", runtimeStatus());
  return runtimeStatus();
}

// 切换输入源模式：helper 在跑则 stop 后以新模式重启，否则仅记录模式、待下次 start 生效。
async function setAudioSourceMode(mode: unknown): Promise<DesktopRuntimeStatus> {
  audioSourceMode = normalizeAudioSourceMode(mode);
  if (audioHelper !== null && audioHelper.exitCode === null) {
    await stopAudioHelper();
    return startAudioHelper();
  }
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

async function startPackagedUiServer(): Promise<string> {
  const serverPath = path.join(process.resourcesPath, "app.asar", ".next", "standalone", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOSTNAME: "127.0.0.1", PORT: String(UI_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  uiServer = child;
  child.stdout.on("data", (chunk) => process.stdout.write(`[CueMind.UI] ${chunk.toString()}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[CueMind.UI] ${chunk.toString()}`));
  child.once("exit", () => {
    if (uiServer === child) uiServer = null;
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${UI_PORT}/`);
      if (response.ok) return `http://127.0.0.1:${UI_PORT}`;
    } catch {
      // The standalone server may need several seconds to bind.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged Next standalone server did not become ready");
}

async function stopPackagedUiServer(): Promise<void> {
  const child = uiServer;
  uiServer = null;
  if (child && child.exitCode === null) child.kill();
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

  const uiUrl = process.env.CUEMIND_UI_URL ?? (app.isPackaged ? await startPackagedUiServer() : "http://localhost:3000");
  await mainWindow.loadURL(uiUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ipcMain.handle 的监听函数实际签名是 (event, ...args)：渲染进程 invoke 的第一个参数落在第二个形参。
ipcMain.handle("runtime:get-status", () => runtimeStatus());
ipcMain.handle("runtime:start-audio-helper", (_event, sources?: unknown) =>
  startAudioHelper(typeof sources === "string" ? normalizeAudioSourceMode(sources) : undefined));
ipcMain.handle("runtime:stop-audio-helper", () => stopAudioHelper());
ipcMain.handle("runtime:set-audio-source-mode", (_event, sources?: unknown) => setAudioSourceMode(sources));

app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => {
  void stopAudioHelper();
  void stopPackagedUiServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
