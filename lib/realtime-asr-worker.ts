export interface AsrDecodeResult { text: string; startMs: number; endMs: number }
export interface ResidentAsrWorkerOptions { maxQueue: number; modelHash: string; device: "cpu" | "cuda"; decode: (pcm: Int16Array) => Promise<AsrDecodeResult> }
export interface ResidentAsrHealth { status: "ready" | "draining" | "stopped" | "error"; queueLength: number; modelHash: string; device: string; lastError?: string }

export class ResidentAsrWorker {
  private readonly options: ResidentAsrWorkerOptions;
  private queue = 0;
  private status: ResidentAsrHealth["status"] = "ready";
  private lastError: string | undefined;

  constructor(options: ResidentAsrWorkerOptions) {
    if (!Number.isInteger(options.maxQueue) || options.maxQueue < 1) throw new Error("maxQueue must be positive");
    this.options = options;
  }

  health(): ResidentAsrHealth { return { status: this.status, queueLength: this.queue, modelHash: this.options.modelHash, device: this.options.device, ...(this.lastError ? { lastError: this.lastError } : {}) }; }

  submit(pcm: Int16Array): Promise<AsrDecodeResult> {
    if (this.status !== "ready") return Promise.reject(new Error("worker unavailable"));
    if (this.queue >= this.options.maxQueue) return Promise.reject(new Error("queue limit exceeded"));
    this.queue += 1;
    return this.options.decode(pcm).catch((error: unknown) => { this.status = "error"; this.lastError = error instanceof Error ? error.message : "decode failed"; throw error; }).finally(() => { this.queue -= 1; });
  }

  async close(): Promise<void> { this.status = "draining"; while (this.queue > 0) await new Promise((resolve) => setTimeout(resolve, 0)); this.status = "stopped"; }
}
