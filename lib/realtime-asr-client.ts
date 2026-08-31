import type { AsrDecodeResult, ResidentAsrHealth } from "@/lib/realtime-asr-worker";

export interface RealtimeAsrClientOptions { endpoint?: string; timeoutMs?: number; fallback?: (pcm: Int16Array) => Promise<AsrDecodeResult> }
export class RealtimeAsrClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fallback?: RealtimeAsrClientOptions["fallback"];
  private lastHealth: ResidentAsrHealth | null = null;
  constructor(options: RealtimeAsrClientOptions = {}) { this.endpoint = options.endpoint ?? "http://127.0.0.1:8765"; this.timeoutMs = options.timeoutMs ?? 10_000; this.fallback = options.fallback; }
  health(): ResidentAsrHealth | null { return this.lastHealth; }
  async transcribe(pcm: Int16Array, segmentId: string): Promise<AsrDecodeResult & { provider: "streaming" | "cli" }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const response = await fetch(`${this.endpoint}/transcribe`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-segment-id": segmentId }, body: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) as BodyInit, signal: controller.signal }).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(`worker HTTP ${response.status}`);
      const payload = await response.json() as { result?: AsrDecodeResult; health?: ResidentAsrHealth };
      if (!payload.result || !payload.health) throw new Error("worker protocol error");
      this.lastHealth = payload.health;
      return { ...payload.result, provider: "streaming" };
    } catch (error) {
      if (!this.fallback) throw error;
      return { ...(await this.fallback(pcm)), provider: "cli" };
    }
  }
}
