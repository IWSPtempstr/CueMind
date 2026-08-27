"use client";

import { useRef, useState, type ReactElement } from "react";
import type { UploadedFileRecord } from "@/hooks/useMediaUploader";

interface Props {
  isProcessing: boolean;
  progress: number | null;
  processingFileName: string | null;
  uploadedFiles: UploadedFileRecord[];
  error: string | null;
  onSelectFiles: (files: FileList | File[]) => Promise<void>;
  onCancel: (uploadId: string) => void;
  onClearError: () => void;
}

export default function MediaUploadPanel({ isProcessing, progress, processingFileName, uploadedFiles, error, onSelectFiles, onClearError }: Props): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">上传媒体转写</h3>
      <div
        role="button"
        tabIndex={0}
        aria-label="拖拽或选择要转写的视频/音频文件"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragOver(false);
          if (event.dataTransfer.files.length > 0) void onSelectFiles(event.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-xs transition-colors ${isDragOver ? "border-blue-500 bg-blue-950/40 text-blue-300" : "border-neutral-700 text-neutral-500 hover:border-neutral-600 hover:bg-neutral-900/60"}`}
      >
        <span aria-hidden>📂</span>
        <span>拖拽视频 / 音频文件到此处，或点击选择（可多选）</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm,video/mov,video/x-matroska,audio/*"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void onSelectFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {isProcessing ? (
        progress !== null ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-blue-300">上传 {processingFileName ?? ""}… {progress}%</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800"><div className="h-full bg-blue-500 transition-[width]" style={{ width: `${progress}%` }} /></div>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-blue-300">正在本地转写 {processingFileName ?? ""}，请耐心等待…</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800"><div className="h-full w-full animate-pulse rounded-full bg-blue-500/50" /></div>
          </div>
        )
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start justify-between gap-2 rounded border border-red-900 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <span className="min-w-0">{error}</span>
          <button type="button" onClick={onClearError} aria-label="忽略错误提示" className="shrink-0 rounded border border-neutral-700 px-2 text-neutral-400 hover:bg-neutral-800">忽略</button>
        </p>
      ) : null}
      <div className="flex flex-col">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">已完成 · {uploadedFiles.length}</p>
        {uploadedFiles.map((file, index) => (
          <div key={file.uploadId} className={`flex items-center justify-between gap-2 py-2 text-xs ${index ? "border-t border-neutral-800" : ""}`}>
            <span className="min-w-0 truncate text-neutral-300">{file.fileName}</span>
            <span className="shrink-0 text-[10px] text-neutral-500">{file.segmentCount} 条 · {file.completedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          </div>
        ))}
        {uploadedFiles.length === 0 ? <p className="py-2 text-xs text-neutral-600">还没有处理完成的文件。</p> : null}
      </div>
      <p className="border-t border-neutral-800 pt-2 text-[10px] leading-relaxed text-neutral-600">长视频请预留本地转写时间；上传文件仅在服务器临时目录处理，完成后自动删除。</p>
    </div>
  );
}
