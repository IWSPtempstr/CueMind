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

interface UploadStreamWindowEvent {
  type: "window";
  uploadId: string;
  windowIndex: number;
  totalWindows: number | null;
  chunks: UploadMediaChunkPayload[];
}

interface UploadStreamDoneEvent {
  type: "done";
  uploadId: string;
  fileName: string;
  originalDurationMs: number | null;
  segmentCount: number;
}

interface UploadStreamErrorEvent {
  type: "error";
  message: string;
  code?: string;
}

type UploadStreamServerEvent =
  | UploadStreamWindowEvent
  | UploadStreamDoneEvent
  | UploadStreamErrorEvent;

/** 转写进度快照：received=已完成窗数，total=null 表示总窗数未知。 */
export interface TranscribeProgressSnapshot {
  received: number;
  total: number | null;
}

type UploadOutcome =
  | { kind: "completed"; payload: UploadStreamDoneEvent }
  | { kind: "rejected"; message: string }
  | { kind: "cancelled" };

export interface UseMediaUploaderArgs {
  setTranscriptChunks: (chunks: TranscriptChunk[]) => void;
  getTranscriptChunks?: () => TranscriptChunk[];
}

/**
 * 已上传文件记录：pending 形态仅含 receivedSegments（进行中），
 * 收到 done 事件后转为 completed 形态（segmentCount + completedAt）。
 */
export interface UploadedFileRecord {
  uploadId: string;
  fileName: string;
  /** pending：已收到的片段数。 */
  receivedSegments?: number;
  /** completed：最终片段条数。 */
  segmentCount?: number;
  completedAt?: Date;
}

export function isUploadedRecordCompleted(
  record: UploadedFileRecord,
): record is UploadedFileRecord & { segmentCount: number; completedAt: Date } {
  return record.completedAt instanceof Date;
}

export interface UseMediaUploaderResult {
  isProcessing: boolean; // 任一文件上传或转写中
  progress: number | null; // 0-100 上传进度；null 表示处于"转写中"阶段
  transcribeProgress: TranscribeProgressSnapshot | null; // 流式逐窗进度
  processingFileName: string | null;
  uploadedFiles: UploadedFileRecord[];
  error: string | null;
  handleFileList: (files: FileList | File[]) => Promise<void>;
  cancelUpload: (uploadId: string) => void;
  clearError: () => void;
}

const WHISPER_SETTINGS_ERROR = "请先在设置中填写 whisper.cpp 可执行文件和模型路径";
const NETWORK_ERROR = "上传处理失败，请检查网络连接后重试。";

function parseStreamEvent(raw: unknown): UploadStreamServerEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  return type === "window" || type === "done" || type === "error"
    ? raw as UploadStreamServerEvent
    : null;
}

/** 从累积的 SSE 文本中按 "\n\n" 切出 data 帧；返回新解析的事件与剩余未完结缓冲。 */
function drainSseFrames(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  let rest = buffer;
  let separator = rest.indexOf("\n\n");
  while (separator !== -1) {
    const frame = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        events.push(JSON.parse(data) as unknown);
      } catch {
        // 忽略无法解析的帧，保持与旧 JSON 路径一致的容错语义。
      }
    }
    separator = rest.indexOf("\n\n");
  }
  return { events, rest };
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
  const [transcribeProgress, setTranscribeProgress] = useState<TranscribeProgressSnapshot | null>(null);
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

  /**
   * 逐窗合并一个 window 事件的 chunks 到既有转写内容：
   * 与既有内容合并后按 startMs 升序稳定排序，绝不覆盖清空既有内容。
   * 每次合并都触发一次 React state 更新，实现逐窗渲染。
   */
  const mergeWindowChunks = useCallback(
    (
      payloadChunks: UploadMediaChunkPayload[],
      uploadId: string,
      fileName: string,
    ): void => {
      const mappedChunks: TranscriptChunk[] = [];
      for (const chunk of payloadChunks) {
        const text = chunk.text.trim();
        if (!text) continue;
        mappedChunks.push({
          id: chunk.audioChunkId,
          text,
          timestamp: new Date(),
          source: "upload",
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          latency: { asrStartedAt: asrStartedAtRef.current, asrEndedAt: new Date() },
        });
      }

      const current = resolveCurrentChunks();
      const merged = [...current, ...mappedChunks].sort(compareUploadOrder);
      mirrorRef.current = merged;
      argsRef.current.setTranscriptChunks(merged);

      // pending 记录：首窗创建，后续窗口累加已收片段数。
      setUploadedFiles((previous) => {
        const exists = previous.some((record) => record.uploadId === uploadId);
        if (!exists) {
          return [
            ...previous,
            { uploadId, fileName, receivedSegments: mappedChunks.length },
          ];
        }
        return previous.map((record) =>
          record.uploadId === uploadId && !isUploadedRecordCompleted(record)
            ? { ...record, receivedSegments: (record.receivedSegments ?? 0) + mappedChunks.length }
            : record,
        );
      });
    },
    [resolveCurrentChunks],
  );

  // 当前请求的 asrStartedAt（在 processOneFile 里写入，供逐窗 latency 记录）。
  const asrStartedAtRef = useRef(new Date());

  /** 流式上传单个文件：XHR 保留上传阶段百分比，响应侧按行解析 SSE data 帧。 */
  const requestStreamingUpload = useCallback(
    (formData: FormData, uploadId: string, fileName: string): Promise<UploadOutcome> =>
      new Promise<UploadOutcome>((resolve) => {
        const xhr = new XMLHttpRequest();
        activeXhrsRef.current.set(uploadId, xhr);
        const finish = (outcome: UploadOutcome): void => {
          activeXhrsRef.current.delete(uploadId);
          resolve(outcome);
        };

        let consumedResponseLength = 0;
        let sseBuffer = "";
        let doneEvent: UploadStreamDoneEvent | null = null;
        let errorMessage: string | null = null;

        // 增量消费 responseText：只解析尚未见过的部分，剩余残片留待下一帧。
        const consumeSseText = (): void => {
          const whole = xhr.responseText;
          if (whole.length <= consumedResponseLength) return;
          sseBuffer += whole.slice(consumedResponseLength);
          consumedResponseLength = whole.length;

          const drained = drainSseFrames(sseBuffer);
          sseBuffer = drained.rest;
          for (const raw of drained.events) {
            const event = parseStreamEvent(raw);
            if (!event) continue;
            if (event.type === "window") {
              mergeWindowChunks(event.chunks, event.uploadId, fileName);
              setTranscribeProgress({ received: event.windowIndex + 1, total: event.totalWindows });
            } else if (event.type === "done") {
              doneEvent = event;
            } else {
              errorMessage = event.message.trim() || errorMessage;
              // 错误帧到达即上屏，不等流结束——用户能第一时间看到失败原因。
              if (errorMessage) setError(errorMessage);
            }
          }
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
        // Response bytes arriving incrementally → parse each window event as it lands.
        xhr.onprogress = () => {
          if (!unmountedRef.current) consumeSseText();
        };
        xhr.onload = () => {
          if (unmountedRef.current) {
            finish({ kind: "cancelled" });
            return;
          }
          consumeSseText();
          if (doneEvent !== null) {
            finish({ kind: "completed", payload: doneEvent });
            return;
          }
          if (errorMessage !== null && errorMessage.length > 0) {
            finish({ kind: "rejected", message: errorMessage });
            return;
          }
          finish({
            kind: "rejected",
            message:
              xhr.status >= 200 && xhr.status < 300
                ? "服务器返回了无法解析的转写结果"
                : `上传处理失败（HTTP ${xhr.status}）`,
          });
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
    [mergeWindowChunks],
  );

  const processOneFile = useCallback(
    async (file: File, settings: Settings): Promise<void> => {
      const uploadId = crypto.randomUUID();

      setProcessingFileName(file.name);
      setProgress(0);
      setTranscribeProgress(null);

      const formData = new FormData();
      formData.append("media", file);
      formData.append("language", settings.localWhisperLanguage);
      formData.append("whisperPath", settings.localWhisperPath.trim());
      formData.append("whisperModelPath", settings.localWhisperModelPath.trim());
      formData.append("uploadId", uploadId);
      formData.append("stream", "1");
      // 会议上下文 + VAD 配置透传给服务端，组装成 whisper initial prompt / --vad 参数。
      formData.append("meetingTopic", settings.meetingTopic.trim());
      formData.append("domainGlossary", settings.domainGlossary.trim());
      formData.append("enableVad", settings.enableVad ? "1" : "0");
      formData.append("vadModelPath", settings.vadModelPath.trim());

      asrStartedAtRef.current = new Date();
      const outcome = await requestStreamingUpload(formData, uploadId, file.name);
      if (unmountedRef.current) return;

      // 完成：把 pending 记录转为完成形态。
      if (outcome.kind === "completed") {
        const { payload } = outcome;
        setUploadedFiles((previous) => {
          const exists = previous.some((record) => record.uploadId === payload.uploadId);
          const next: UploadedFileRecord = {
            uploadId: payload.uploadId,
            fileName: payload.fileName,
            segmentCount: payload.segmentCount,
            completedAt: new Date(),
          };
          return exists
            ? previous.map((record) => (record.uploadId === payload.uploadId ? next : record))
            : [...previous, next];
        });
        setError(null);
        return;
      }

      // 清理 pending 条目：取消保持静默（不置 error，与既有行为一致），
      // 失败则把失败原因上屏（rejected outcome 携带服务端/网络错误消息）。
      cancelledIdsRef.current.delete(uploadId);
      setUploadedFiles((previous) => previous.filter((record) => record.uploadId !== uploadId));
      if (outcome.kind === "rejected") {
        setError(outcome.message);
      }
    },
    [requestStreamingUpload],
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
          setTranscribeProgress(null);
          setProcessingFileName(null);
        }
      }
    },
    [processOneFile],
  );

  const cancelUpload = useCallback((uploadId: string): void => {
    cancelledIdsRef.current.add(uploadId);
    // 中断连接后服务端监听 request.signal abort，停止后续窗口并清理临时文件。
    activeXhrsRef.current.get(uploadId)?.abort();
  }, []);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  return {
    isProcessing,
    progress,
    transcribeProgress,
    processingFileName,
    uploadedFiles,
    error,
    handleFileList,
    cancelUpload,
    clearError,
  };
}
