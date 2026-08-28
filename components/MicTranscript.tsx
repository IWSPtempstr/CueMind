"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { AUDIO_SOURCE_MODE_LABELS, AUDIO_SOURCE_MODES, type AudioSourceMode } from "@/lib/audio-source-mode";
import { SPEAKER_ROLE_LABELS } from "@/lib/speaker-attributes";
import type { MeetingReport, TranscriptChunk } from "@/types/session";

interface Props {
  transcriptChunks: TranscriptChunk[];
  isRecording: boolean;
  isPaused: boolean;
  micLevel: number;
  retryCount: number;
  onRecordingChange: (recording: boolean) => void;
  onPauseToggle: () => void;
  recordingError: string | null;
  meetingReport: MeetingReport | null;
  isReportLoading: boolean;
  isUploadProcessing?: boolean;
  uploaderSlot?: ReactNode;
  isDesktop?: boolean;
  audioSourceMode?: AudioSourceMode;
  onAudioSourceModeChange?: (mode: AudioSourceMode) => void;
  /** 进行中 segment 的临时转写（决策 66 partial 态，仅麦克风链路）；confirmed 到达后置 null。 */
  partialText?: string | null;
}

function Highlight({ text, query }: { text: string; query: string }): ReactElement {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pieces = text.split(new RegExp(`(${escaped})`, "gi"));
  return <>{pieces.map((piece, index) => piece.toLowerCase() === query.toLowerCase() ? <mark key={index} className="bg-yellow-500/40 text-inherit">{piece}</mark> : piece)}</>;
}

/** 上传流式 chunk id 形如 "<uploadId>-w<windowIndex>-<index>"；提取窗索引，非该格式（如麦克风老数据）返回 null。 */
function windowIndexOf(id: string): number | null {
  const match = /-w(\d+)-\d+$/.exec(id);
  return match ? Number(match[1]) : null;
}

export default function MicTranscript(props: Props): ReactElement {
  const { transcriptChunks, isRecording, isPaused, micLevel, retryCount, onRecordingChange, onPauseToggle, recordingError, meetingReport, isReportLoading, isUploadProcessing = false, uploaderSlot, isDesktop = false, audioSourceMode = "mixed", onAudioSourceModeChange, partialText = null } = props;
  const endRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"mic" | "upload">("mic");
  const filtered = useMemo(() => transcriptChunks.filter((chunk) => chunk.text.toLowerCase().includes(search.trim().toLowerCase())), [search, transcriptChunks]);

  // 列表底部自动跟随：confirmed 追加（length 变化）或 partial 出现/更新时滚到底。
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcriptChunks.length, partialText]);
  const copyTranscript = async (): Promise<void> => {
    await navigator.clipboard.writeText(transcriptChunks.map((chunk) => `[${chunk.timestamp.toLocaleTimeString()}] ${chunk.text}`).join("\n\n"));
  };

  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col border-r border-neutral-800 lg:h-auto lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">1. 麦克风与转写</h2>
        <span className={`rounded-full border border-neutral-700 px-2.5 py-1 text-[10px] font-semibold ${isRecording ? "text-red-400" : "text-neutral-400"}`}>{isPaused ? "已暂停" : isRecording ? "录音中" : "空闲"}</span>
      </header>
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setActiveTab("mic")} aria-pressed={activeTab === "mic"} className={`rounded border px-3 py-1 text-xs ${activeTab === "mic" ? "border-neutral-600 bg-neutral-800 text-neutral-200" : "border-neutral-800 text-neutral-500 hover:text-neutral-300"}`}>麦克风</button>
          <button type="button" onClick={() => setActiveTab("upload")} aria-pressed={activeTab === "upload"} className={`rounded border px-3 py-1 text-xs ${activeTab === "upload" ? "border-neutral-600 bg-neutral-800 text-neutral-200" : "border-neutral-800 text-neutral-500 hover:text-neutral-300"}`}>上传</button>
        </div>
        {isDesktop ? (
          <div className="flex items-center gap-1" role="group" aria-label="输入源模式">
            {AUDIO_SOURCE_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={audioSourceMode === mode}
                onClick={() => onAudioSourceModeChange?.(mode)}
                className={`rounded border px-2.5 py-1 text-xs ${audioSourceMode === mode ? "border-neutral-600 bg-neutral-800 text-neutral-200" : "border-neutral-800 text-neutral-500 hover:text-neutral-300"}`}
              >
                {AUDIO_SOURCE_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        {activeTab === "upload" ? (
          uploaderSlot
        ) : (
          <div className="flex flex-col items-center gap-3">
            <button type="button" onClick={() => onRecordingChange(!isRecording)} aria-pressed={isRecording} disabled={isUploadProcessing} aria-label={isUploadProcessing ? "转写中…" : isRecording ? "停止录音" : "开始录音"} className={`flex size-24 items-center justify-center rounded-full border-2 shadow-lg ${isRecording ? "border-red-400/60 bg-red-600 text-3xl text-white" : "border-blue-500/40 bg-blue-600 text-4xl hover:bg-blue-500"} ${isUploadProcessing ? "cursor-not-allowed opacity-40" : ""}`}>{isRecording ? "■" : "🎙️"}</button>
            {isRecording ? <p className="text-[10px] text-neutral-500">点击结束并生成会议总结</p> : null}
            <div className="h-2 w-40 overflow-hidden rounded-full bg-neutral-800" aria-label={`Microphone level ${Math.round(micLevel * 100)} percent`}><div className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: `${Math.round(micLevel * 100)}%` }} /></div>
            {isRecording ? <button type="button" onClick={onPauseToggle} className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800">{isPaused ? "▶ 继续" : "Ⅱ 暂停"}</button> : null}
            {retryCount > 0 ? <p className="text-xs text-amber-300">保留 {retryCount} 个音频片段，等待重试…</p> : null}
            {recordingError ? <p className="max-w-xs text-center text-xs text-red-500">{recordingError}</p> : null}
          </div>
        )}

        <div className="flex gap-2">
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索转写…" className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-neutral-200" />
          <button type="button" disabled={transcriptChunks.length === 0} onClick={() => void copyTranscript()} className="rounded border border-neutral-700 px-2 text-xs text-neutral-400 disabled:opacity-40">复制全部</button>
        </div>

        <div className="flex flex-col">
          {filtered.map((chunk, index) => {
            const previous = index > 0 ? filtered[index - 1] : undefined;
            const timeGapBreak = previous !== undefined
              && typeof previous.endMs === "number"
              && typeof chunk.startMs === "number"
              && chunk.startMs - previous.endMs > 800;
            // whisper 相邻段的时间戳常首尾相接（endMs[i-1] == startMs[i]，时间差条件探不到窗边界），
            // 因此窗标记（audioChunkId 的 w 索引）变化也视为话题边界；老数据（麦克风）无标记不触发。
            const previousWindow = previous !== undefined ? windowIndexOf(previous.id) : null;
            const currentWindow = windowIndexOf(chunk.id);
            const windowChangeBreak = previousWindow !== null && currentWindow !== null && previousWindow !== currentWindow;
            const isTopicBreak = timeGapBreak || windowChangeBreak;
            return (
              <article key={chunk.id} className={`py-3 ${index ? "border-t border-neutral-800" : ""} ${isTopicBreak ? "mt-6" : ""}`}><div className="mb-1 flex items-center gap-2"><time className="text-[10px] text-neutral-600">{chunk.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>{chunk.source ? <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] text-neutral-500">{chunk.source === "system" ? "系统音频" : chunk.source === "upload" ? "上传" : "麦克风"}</span> : null}{chunk.speaker ? <span className={`rounded border px-1.5 py-0.5 text-[9px] ${chunk.speaker === "you" ? "border-blue-800 text-blue-300" : "border-emerald-800 text-emerald-300"}`}>{SPEAKER_ROLE_LABELS[chunk.speaker]}</span> : null}</div><p className="text-sm leading-relaxed text-neutral-300"><Highlight text={chunk.text} query={search.trim()} /></p></article>
            );
          })}
          {/* partial 行（决策 66）：仅 isRecording && partialText 非空渲染，不参与上方段落分组；
              暂停/confirmed/停止时 hook 已置 partialText=null，本行自然消失。 */}
          {isRecording && partialText ? (
            <article className="py-3 border-t border-neutral-800" aria-live="polite">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded border border-neutral-500 px-1.5 py-0.5 text-[10px] text-neutral-500">partial</span>
              </div>
              <p className="text-sm italic leading-relaxed text-neutral-500">{partialText}<span className="animate-pulse" aria-hidden> …</span></p>
            </article>
          ) : null}
          {transcriptChunks.length === 0 && !partialText ? <p className="text-center text-sm text-neutral-600">还没有转写，点击麦克风开始。</p> : null}
          {transcriptChunks.length > 0 && filtered.length === 0 ? <p className="text-center text-sm text-neutral-600">没有匹配的转写内容。</p> : null}
          <div ref={endRef} aria-hidden />
        </div>

        {isReportLoading ? <div className="animate-pulse rounded-lg border border-blue-900 bg-blue-950/20 p-4 text-sm text-blue-300">正在整理决策与后续行动…</div> : null}
        {meetingReport ? <section className="rounded-lg border border-blue-900 bg-blue-950/20 p-4"><div className="mb-2 flex justify-between"><h3 className="text-xs font-semibold uppercase tracking-wider text-blue-300">会议总结</h3><button type="button" onClick={() => void navigator.clipboard.writeText(meetingReport.content)} className="text-xs text-neutral-400">复制</button></div><div className="prose prose-invert prose-sm max-w-none"><ReactMarkdown>{meetingReport.content}</ReactMarkdown></div></section> : null}
      </div>
    </section>
  );
}
