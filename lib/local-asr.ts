import { spawn } from "node:child_process";

export interface LocalAsrRequest {
  whisperPath: string;
  modelPath: string;
  audioPath: string;
  language: "auto" | "zh" | "en";
}

export interface LocalAsrResult {
  text: string;
  latencyMs: number;
}

export async function transcribeWithWhisperCpp(
  request: LocalAsrRequest,
): Promise<LocalAsrResult> {
  const started = performance.now();
  const args = ["-m", request.modelPath, "-f", request.audioPath, "-otxt", "-nt"];
  if (request.language !== "auto") args.push("-l", request.language);

  const output = await runProcess(request.whisperPath, args, 60_000);
  return {
    text: output.trim(),
    latencyMs: Math.round(performance.now() - started),
  };
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Local ASR timed out after 60 seconds"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start local ASR: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `Local ASR exited with code ${code ?? "unknown"}`));
    });
  });
}
