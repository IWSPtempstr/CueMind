"use client";

// Right column: always-visible live health metrics for the ASR pipeline,
// replacing the collapsible LatencyPanel summary in the realtime console.

import type { ReactElement } from "react";

export interface AsrStatusSnapshot {
  state: "idle" | "recording" | "paused";
  source: string;
  retryCount: number;
  error: string | null;
  // 仅桌面模式传入：当前输入源模式（如「混合采集」）。
  sourceMode?: string;
}

export interface UploadStatusSnapshot {
  processing: boolean;
  fileName: string | null;
  progressPercent: number | null;
  windows: { received: number; total: number | null } | null;
}

export interface LatencySummary {
  stage: string;
  label: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

interface HealthPanelProps {
  asrStatus: AsrStatusSnapshot;
  uploadStatus: UploadStatusSnapshot | null;
  cardCount: number;
  failureCount: number;
  latestTotalLatencyMs: number | null;
  latencySummaries: LatencySummary[];
  queueStatus: string | null;
  degradationStatus: string | null;
}

const ASR_STATE_META = {
  idle: { label: "空闲", dot: "bg-neutral-500", text: "text-neutral-400" },
  recording: { label: "录音中", dot: "animate-pulse bg-red-500", text: "text-red-400" },
  paused: { label: "已暂停", dot: "bg-amber-400", text: "text-amber-300" },
} as const;

function displayMs(value: number | null): string {
  return value === null ? "-" : `${(value / 1000).toFixed(1)}s`;
}

export default function HealthPanel(props: HealthPanelProps): ReactElement {
  const {
    asrStatus,
    uploadStatus,
    cardCount,
    failureCount,
    latestTotalLatencyMs,
    latencySummaries,
    queueStatus,
    degradationStatus,
  } = props;
  const chainActive = asrStatus.state === "recording" || Boolean(uploadStatus?.processing);
  const stateMeta = ASR_STATE_META[asrStatus.state];
  const hasLatencyData = latencySummaries.some((summary) => summary.count > 0);

  return (
    <aside className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto border-l border-neutral-800 px-4 py-5 tabular-nums lg:h-auto lg:w-72 lg:shrink-0">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">实时健康指标</h2>
        <span
          aria-label={chainActive ? "链路活跃" : "链路空闲"}
          aria-hidden={!chainActive}
          className={`size-2 rounded-full ${chainActive ? "animate-pulse bg-emerald-500" : "bg-neutral-700"}`}
        />
      </div>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3" aria-label="ASR 状态">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">ASR 状态</p>
          <span className={`flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] font-semibold ${stateMeta.text}`}>
            <span aria-hidden className={`size-1.5 rounded-full ${stateMeta.dot}`} />
            {stateMeta.label}
          </span>
        </div>
        <p className="mt-2 truncate text-xs text-neutral-300">输入来源：{uploadStatus?.processing ? "上传转写中…" : asrStatus.source}</p>
        {asrStatus.sourceMode ? <p className="truncate text-xs text-neutral-300">输入源：{asrStatus.sourceMode}</p> : null}
        {uploadStatus?.processing ? (
          <div className="mt-2">
            {uploadStatus.fileName ? <p className="truncate text-[10px] text-neutral-500" title={uploadStatus.fileName}>{uploadStatus.fileName}</p> : null}
            {uploadStatus.progressPercent !== null ? (
              <>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                  <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${uploadStatus.progressPercent}%` }} />
                </div>
                <p className="mt-1 text-[10px] text-neutral-500">上传进度 {uploadStatus.progressPercent}%</p>
              </>
            ) : (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"><div className="h-full w-1/3 animate-pulse bg-blue-500" /></div>
            )}
            {uploadStatus.windows ? (
              <p className="mt-1 text-[10px] text-neutral-500">转写窗口 {uploadStatus.windows.received}{uploadStatus.windows.total !== null ? ` / ${uploadStatus.windows.total}` : ""}</p>
            ) : null}
          </div>
        ) : null}
        {asrStatus.retryCount > 0 ? <p className="mt-2 text-xs text-amber-300">{asrStatus.retryCount} 个片段等待重试</p> : null}
        {asrStatus.error ? <p className="mt-2 truncate text-xs text-red-500" title={asrStatus.error}>{asrStatus.error}</p> : null}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3" aria-label="最近窗口延迟">
        <div className="flex items-baseline justify-between">
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">最近窗口延迟</p>
          <p className="text-xs text-neutral-200">总耗时 {displayMs(latestTotalLatencyMs)}</p>
        </div>
        {hasLatencyData ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {latencySummaries.map((summary) => (
              <div key={summary.stage} className="rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1.5">
                <p className="text-[10px] text-neutral-500">{summary.label} · n={summary.count}</p>
                <p className="mt-1 text-xs text-neutral-300">P50 {displayMs(summary.p50)}</p>
                <p className="text-xs text-neutral-500">P95 {displayMs(summary.p95)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-neutral-600">等待数据</p>
        )}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3" aria-label="卡片统计">
        <p className="text-[10px] uppercase tracking-wider text-neutral-500">卡片统计</p>
        <div className="mt-2 flex items-end justify-between">
          <p className="text-2xl font-semibold leading-none text-neutral-100">{cardCount}</p>
          <p className={`text-xs ${failureCount > 0 ? "text-red-400" : "text-neutral-500"}`}>失败 {failureCount}</p>
        </div>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-neutral-500">队列状态</dt>
            <dd className="truncate text-neutral-300">{queueStatus ?? "正常"}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-neutral-500">成功 / 降级</dt>
            <dd className={`truncate ${degradationStatus !== null ? "text-emerald-300" : "text-neutral-500"}`}>{degradationStatus ?? "未检测到降级"}</dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}
