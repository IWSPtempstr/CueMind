"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
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
}

function Highlight({ text, query }: { text: string; query: string }): ReactElement {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pieces = text.split(new RegExp(`(${escaped})`, "gi"));
  return <>{pieces.map((piece, index) => piece.toLowerCase() === query.toLowerCase() ? <mark key={index} className="bg-yellow-500/40 text-inherit">{piece}</mark> : piece)}</>;
}

export default function MicTranscript(props: Props): ReactElement {
  const { transcriptChunks, isRecording, isPaused, micLevel, retryCount, onRecordingChange, onPauseToggle, recordingError, meetingReport, isReportLoading } = props;
  const endRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => transcriptChunks.filter((chunk) => chunk.text.toLowerCase().includes(search.trim().toLowerCase())), [search, transcriptChunks]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [transcriptChunks.length]);
  const copyTranscript = async (): Promise<void> => {
    await navigator.clipboard.writeText(transcriptChunks.map((chunk) => `[${chunk.timestamp.toLocaleTimeString()}] ${chunk.text}`).join("\n\n"));
  };

  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col border-r border-neutral-800 lg:h-auto lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">1. MIC & TRANSCRIPT</h2>
        <span className={`rounded-full border border-neutral-700 px-2.5 py-1 text-[10px] font-semibold uppercase ${isRecording ? "text-red-400" : "text-neutral-400"}`}>{isPaused ? "PAUSED" : isRecording ? "RECORDING" : "IDLE"}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        <div className="flex flex-col items-center gap-3">
          <button type="button" onClick={() => onRecordingChange(!isRecording)} aria-pressed={isRecording} aria-label={isRecording ? "Stop recording" : "Start recording"} className={`flex size-24 items-center justify-center rounded-full border-2 text-4xl shadow-lg ${isRecording ? "border-red-400/60 bg-red-600" : "border-blue-500/40 bg-blue-600 hover:bg-blue-500"}`}>🎙️</button>
          <div className="h-2 w-40 overflow-hidden rounded-full bg-neutral-800" aria-label={`Microphone level ${Math.round(micLevel * 100)} percent`}><div className="h-full bg-emerald-500 transition-[width] duration-75" style={{ width: `${Math.round(micLevel * 100)}%` }} /></div>
          {isRecording ? <button type="button" onClick={onPauseToggle} className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800">{isPaused ? "▶ Resume" : "Ⅱ Pause"}</button> : null}
          {retryCount > 0 ? <p className="text-xs text-amber-300">Keeping {retryCount} audio chunk{retryCount === 1 ? "" : "s"} safe for retry…</p> : null}
          {recordingError ? <p className="max-w-xs text-center text-xs text-red-500">{recordingError}</p> : null}
        </div>

        <div className="flex gap-2">
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transcript…" className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-neutral-200" />
          <button type="button" disabled={transcriptChunks.length === 0} onClick={() => void copyTranscript()} className="rounded border border-neutral-700 px-2 text-xs text-neutral-400 disabled:opacity-40">Copy all</button>
        </div>

        <div className="flex flex-col">
          {filtered.map((chunk, index) => <article key={chunk.id} className={`py-3 ${index ? "border-t border-neutral-800" : ""}`}><time className="mb-1 block text-[10px] text-neutral-600">{chunk.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><p className="text-sm leading-relaxed text-neutral-300"><Highlight text={chunk.text} query={search.trim()} /></p></article>)}
          {transcriptChunks.length === 0 ? <p className="text-center text-sm text-neutral-600">No transcript yet — start the mic.</p> : null}
          {transcriptChunks.length > 0 && filtered.length === 0 ? <p className="text-center text-sm text-neutral-600">No matching transcript moments.</p> : null}
          <div ref={endRef} aria-hidden />
        </div>

        {isReportLoading ? <div className="animate-pulse rounded-lg border border-blue-900 bg-blue-950/20 p-4 text-sm text-blue-300">Turning the meeting into decisions and next steps…</div> : null}
        {meetingReport ? <section className="rounded-lg border border-blue-900 bg-blue-950/20 p-4"><div className="mb-2 flex justify-between"><h3 className="text-xs font-semibold uppercase tracking-wider text-blue-300">Meeting wrap-up</h3><button type="button" onClick={() => void navigator.clipboard.writeText(meetingReport.content)} className="text-xs text-neutral-400">Copy</button></div><div className="prose prose-invert prose-sm max-w-none"><ReactMarkdown>{meetingReport.content}</ReactMarkdown></div></section> : null}
      </div>
    </section>
  );
}
