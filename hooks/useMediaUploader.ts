"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadCueMindSettings } from "@/hooks/useSettings";
import type { Settings } from "@/types/settings";
import type { TranscriptChunk } from "@/types/session";

interface UploadMediaChunkPayload {
  startMs: number;
  endMs: number;
  text: string;
  audioChunkId: string;
  source: "upload";
}

interface UploadMediaSuccessPayload {
  uploadId: string;
  fileName: string;
  originalDurationMs: number | null;
  segmentCount: number;
  chunks: UploadMediaChunkPayload[];
}

type UploadOutcome =
  | { kind: "completed"; payload: UploadMediaSuccessPayload }
  | { kind: "rejected"; message: string }
  | { kind: "cancelled" };

export interface UseMediaUploaderArgs {
  setTranscriptChunks: (chunks: TranscriptChunk[]) => void;
  getTranscriptChunks?: () => TranscriptChunk[];
}

export interface UploadedFileRecord {
  uploadId: string;
  fileName: string;
  segmentCount: number;
  completedAt: Date;
}

export interface UseMediaUploaderResult {
  isProcessing: boolean; // 任一文件上传或转写中
  progress: number | null; // 0-100 上传进度；null 表示处于"转写中"阶段
  processingFileName: string | null;
  uploadedFiles: UploadedFileRecord[];
  error: string | null;
  handleFileList: (files: FileList | File[]) => Promise<void>;
  cancelUpload: (uploadId: string) => void;
  clearError: () => void;
}

const WHISPER_SETTINGS_ERROR = "请先在设置中填写 whisper.cpp 可执行文件和模型路径";
const NETWORK_ERROR = "上传处理失败，请检查网络连接后重试。";

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
}

function extractErrorField(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : null;
}

function parseOutcome(status: number, bodyText: string): UploadOutcome {
  const payload = parseJsonBody(bodyText);
  if (status >= 200 && status < 300) {
    if (
      typeof payload === "object" && payload !== null
      && Array.isArray((payload as { chunks?: unknown }).chunks)
    ) {
      return { kind: "completed", payload: payload as UploadMediaSuccessPayload };
    }
    return { kind: "rejected", message: `服务器返回了无法解析的转写结果（HTTP ${status}）` };
  }
  return {
    kind: "rejected",
    message: extractErrorField(payload) ?? `上传处理失败（HTTP ${status}）`,
  };
}

function compareUploadOrder(left: TranscriptChunk, right: TranscriptChunk): number {
  const leftStart = left.startMs ?? Number.POSITIVE_INFINITY;
  const rightStart = right.startMs ?? Number.POSITIVE_INFINITY;
  return leftStart - rightStart || left.timestamp.getTime() - right.timestamp.getTime();
}

export default function useMediaUploader({
  setTranscriptChunks,
  getTranscriptChunks,
}: UseMediaUploaderArgs): UseMediaUploaderResult {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [processingFileName, setProcessingFileName] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Refreshed on every render so long-running async work always reads the latest
  // closures instead of a capture-time snapshot (stale-closure guard).
  const argsRef = useRef({ setTranscriptChunks, getTranscriptChunks });
  argsRef.current = { setTranscriptChunks, getTranscriptChunks };
  // Mirror of the newest transcript list this hook produced or observed; used as
  // the merge base when no getTranscriptChunks callback was provided.
  const mirrorRef = useRef<TranscriptChunk[]>([]);
  const activeXhrsRef = useRef(new Map<string, XMLHttpRequest>());
  const cancelledIdsRef = useRef(new Set<string>());
  const isBusyRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => () => {
    unmountedRef.current = true;
    for (const xhr of activeXhrsRef.current.values()) xhr.abort();
    activeXhrsRef.current.clear();
  }, []);

  const resolveCurrentChunks = useCallback((): TranscriptChunk[] => {
    const getter = argsRef.current.getTranscriptChunks;
    if (getter) {
      const latest = getter();
      mirrorRef.current = latest;
      return latest;
    }
    return mirrorRef.current;
  }, []);

  const requestUpload = useCallback(
    (formData: FormData, uploadId: string): Promise<UploadOutcome> =>
      new Promise<UploadOutcome>((resolve) => {
        const xhr = new XMLHttpRequest();
        activeXhrsRef.current.set(uploadId, xhr);
        const finish = (outcome: UploadOutcome): void => {
          activeXhrsRef.current.delete(uploadId);
          resolve(outcome);
        };

        xhr.open("POST", "/api/upload-media");
        xhr.upload.onprogress = (event) => {
          if (unmountedRef.current || !event.lengthComputable) return;
          setProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        };
        // Upload bytes fully sent → switch to the indeterminate "transcribing" stage.
        xhr.upload.onload = () => {
          if (!unmountedRef.current) setProgress(null);
        };
        xhr.onload = () => {
          if (unmountedRef.current) {
            finish({ kind: "cancelled" });
            return;
          }
          finish(parseOutcome(xhr.status, xhr.responseText));
        };
        xhr.onerror = () => {
          if (unmountedRef.current) {
            finish({ kind: "cancelled" });
            return;
          }
          finish({ kind: "rejected", message: NETWORK_ERROR });
        };
        xhr.onabort = () => finish({ kind: "cancelled" });
        xhr.send(formData);
      }),
    [],
  );

  const processOneFile = useCallback(
    async (file: File, settings: Settings): Promise<void> => {
      const uploadId = crypto.randomUUID();
      const asrStartedAt = new Date();

      setProcessingFileName(file.name);
      setProgress(0);

      const formData = new FormData();
      formData.append("media", file);
      formData.append("language", settings.localWhisperLanguage);
      formData.append("whisperPath", settings.localWhisperPath.trim());
      formData.append("whisperModelPath", settings.localWhisperModelPath.trim());
      formData.append("uploadId", uploadId);

      const outcome = await requestUpload(formData, uploadId);
      if (unmountedRef.current) return;

      // 取消则静默清理：不置 error、不记入 uploadedFiles。
      if (outcome.kind !== "completed") {
        cancelledIdsRef.current.delete(uploadId);
        return;
      }

      const asrEndedAt = new Date();
      const mappedChunks: TranscriptChunk[] = [];
      for (const chunk of outcome.payload.chunks) {
        const text = chunk.text.trim();
        if (!text) continue;
        mappedChunks.push({
          id: chunk.audioChunkId,
          text,
          timestamp: new Date(),
          source: "upload",
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          latency: { asrStartedAt, asrEndedAt },
        });
      }

      // 与既有内容合并后按 startMs 升序稳定排序，绝不覆盖清空既有内容。
      const current = resolveCurrentChunks();
      const merged = [...current, ...mappedChunks].sort(compareUploadOrder);
      mirrorRef.current = merged;
      argsRef.current.setTranscriptChunks(merged);

      setUploadedFiles((previous) => [
        ...previous,
        {
          uploadId: outcome.payload.uploadId,
          fileName: outcome.payload.fileName,
          segmentCount: outcome.payload.segmentCount,
          completedAt: new Date(),
        },
      ]);
      setError(null);
    },
    [requestUpload, resolveCurrentChunks],
  );

  const handleFileList = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const list = Array.from(files as ArrayLike<File>);
      if (list.length === 0) return;
      if (isBusyRef.current) return; // 已有批次在串行处理中，避免并发打爆 whisper

      const settings = loadCueMindSettings();
      if (!settings.localWhisperPath.trim() || !settings.localWhisperModelPath.trim()) {
        setError(WHISPER_SETTINGS_ERROR);
        return;
      }

      isBusyRef.current = true;
      setError(null);
      setIsProcessing(true);
      try {
        for (const file of list) {
          if (unmountedRef.current) return;
          await processOneFile(file, settings);
        }
      } finally {
        isBusyRef.current = false;
        if (!unmountedRef.current) {
          setIsProcessing(false);
          setProgress(null);
          setProcessingFileName(null);
        }
      }
    },
    [processOneFile],
  );

  const cancelUpload = useCallback((uploadId: string): void => {
    cancelledIdsRef.current.add(uploadId);
    activeXhrsRef.current.get(uploadId)?.abort();
  }, []);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  return {
    isProcessing,
    progress,
    processingFileName,
    uploadedFiles,
    error,
    handleFileList,
    cancelUpload,
    clearError,
  };
}
