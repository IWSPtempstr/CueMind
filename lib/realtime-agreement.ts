import type { RealtimeAsrEvent } from "@/lib/realtime-asr-contract";

export interface DecodeSnapshot { text: string; startMs: number; endMs: number }
export class LocalAgreement2 {
  private previous: DecodeSnapshot | null = null;
  private watermark = 0;
  private rollbackCount = 0;
  private duplicateCount = 0;
  get confirmedUntilMs(): number { return this.watermark; }
  push(next: DecodeSnapshot): { confirmedText: string; partialText: string } {
    if (next.endMs < this.watermark) { this.rollbackCount += 1; return { confirmedText: "", partialText: next.text }; }
    const stable = this.previous ? commonPrefix(this.previous.text, next.text) : "";
    const confirmedText = stable.slice(0, Math.max(0, stable.length - (stable.endsWith(" ") ? 1 : 0))).trim();
    if (confirmedText && next.endMs >= this.watermark) this.watermark = Math.max(this.watermark, this.previous?.endMs ?? next.endMs);
    if (confirmedText === this.previous?.text) this.duplicateCount += 1;
    this.previous = next;
    return { confirmedText, partialText: next.text };
  }
  metrics(): { rollbackCount: number; duplicateCount: number } { return { rollbackCount: this.rollbackCount, duplicateCount: this.duplicateCount }; }
}

function commonPrefix(a: string, b: string): string {
  const left = a.trim().split(/\s+/); const right = b.trim().split(/\s+/); const words: string[] = [];
  while (words.length < left.length && words.length < right.length && left[words.length] === right[words.length]) words.push(left[words.length]);
  return words.join(" ");
}

export function encodeSseEvent(event: RealtimeAsEvent): string { return `data: ${JSON.stringify(event)}\n\n`; }
export function parseSseFrames(input: string): RealtimeAsEvent[] {
  return input.split(/\n\s*\n/).flatMap((frame) => { const line = frame.split("\n").find((item) => item.startsWith("data:")); if (!line) return []; try { const value = JSON.parse(line.slice(5).trim()) as RealtimeAsEvent; return value && typeof value.type === "string" ? [value] : []; } catch { return []; } });
}
type RealtimeAsEvent = RealtimeAsrEvent;
