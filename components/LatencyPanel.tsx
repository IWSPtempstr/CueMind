"use client";

import type { ReactElement } from "react";
import { summarizeLatency, type LatencySample, type LatencyStage } from "@/lib/telemetry";

interface Props {
  samples: LatencySample[];
  skippedFailures: number;
  latestTotalLatencyMs?: number | null;
  cardCount?: number;
  queueStatus?: string | null;
  degradationStatus?: string | null;
}

const stages: Array<{ stage: LatencyStage; label: string }> = [
  { stage: "asr", label: "ASR" },
  { stage: "keyword", label: "关键词" },
  { stage: "search", label: "检索" },
  { stage: "generation", label: "生成" },
  { stage: "total", label: "卡片总耗时" },
];

function displayMs(value: number | null): string {
  return value === null ? "-" : `${(value / 1000).toFixed(1)}s`;
}

export default function LatencyPanel({ samples, skippedFailures, latestTotalLatencyMs = null, cardCount = 0, queueStatus = null, degradationStatus = null }: Props): ReactElement {
  const total = summarizeLatency(samples, "total");
  const overBudget = total.p95 !== null && total.p95 > 15_000;

  return (
    <details className="border-b border-neutral-800 bg-neutral-950 px-4 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-neutral-400">
        <span>延迟观测 · 最近总耗时 {displayMs(latestTotalLatencyMs)} · {cardCount} 张卡片</span>
        <span className={overBudget ? "text-red-300" : "text-emerald-300"}>
          {total.p95 === null ? "等待数据" : `卡片 P95 ${displayMs(total.p95)}${overBudget ? " · 超过 15s" : ""}`}
        </span>
      </summary>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500">
        <span>失败 {skippedFailures} 次</span>
        <span>队列 {queueStatus ?? "正常"}</span>
        <span>降级 {degradationStatus ?? "未检测到"}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 pb-1 md:grid-cols-5">
        {stages.map(({ stage, label }) => {
          const summary = summarizeLatency(samples, stage);
          return (
            <div key={stage} className="rounded border border-neutral-800 bg-neutral-900/70 px-2 py-1.5">
              <p className="text-[10px] text-neutral-500">{label} · n={summary.count}</p>
              <p className="mt-1 text-xs text-neutral-300">P50 {displayMs(summary.p50)}</p>
              <p className="text-xs text-neutral-500">P95 {displayMs(summary.p95)}</p>
            </div>
          );
        })}
      </div>
    </details>
  );
}
