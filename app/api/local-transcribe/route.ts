import { NextResponse } from "next/server";
import { ensureWarmedUp, transcribeWithWhisperCpp } from "@/lib/local-asr";
import { parseLocalTranscribeRequest } from "@/lib/local-transcribe-contract";

export const runtime = "nodejs";

export async function POST(
  request: Request,
): Promise<NextResponse<LocalTranscribeResponse | { error: string }>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseLocalTranscribeRequest(body);
  if (!parsed) {
    return NextResponse.json(
      { error: "runId, audioPath, whisperPath, modelPath, source, and timing fields are required" },
      { status: 400 },
    );
  }

  // 长会话预热（master plan 2.3-b）：fire-and-forget，不 await，保持路由延迟零变化。
  // 首窗请求可能与预热并发执行（whisper-cli 进程级串行由 OS 调度）；预热的价值在于
  // 提前消除 whisper 的 JSON/模型加载冷启动。ensureWarmedUp 内部吞错、永不 reject，
  // 且进程生命周期内仅真实预热一次，void 丢弃不会产生 unhandled rejection。
  void ensureWarmedUp(parsed.settings);

  try {
    const result = await transcribeWithWhisperCpp({
      audioPath: parsed.audioPath,
      whisperPath: parsed.settings.whisperPath,
      modelPath: parsed.settings.modelPath,
      language: parsed.settings.language,
      timeoutMs: parsed.settings.timeoutMs,
      promptContext: parsed.settings.promptContext,
      vad: parsed.settings.vad,
    });
    return NextResponse.json({ ...result, runId: parsed.runId });
  } catch (caught) {
    return NextResponse.json(
      { error: caught instanceof Error ? caught.message : "Local ASR failed" },
      { status: 502 },
    );
  }
}

type LocalTranscribeResponse = {
  runId: string;
  text: string;
  latencyMs: number;
  audioDurationMs: number | null;
  realTimeFactor: number | null;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
  provider: "local-whisper";
  modelPath: string;
};
