import { parseDesktopEvent } from "@/lib/desktop-events";

const parsed = parseDesktopEvent(JSON.stringify({
  type: "transcript_ready",
  id: "t1",
  audioChunkId: "a1",
  source: "system",
  text: "hello",
  timestamp: "2026-08-21T00:00:00.000Z",
  startMs: 0,
  endMs: 1000,
}));

if (parsed?.type === "transcript_ready") {
  const source: "system" | "microphone" = parsed.source;
  const text: string = parsed.text;
  void source;
  void text;
}
