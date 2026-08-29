"use client";

// Right column (decision 68): live-ask panel — question input, stage
// progress (keyword → search → generation), cited answers whose sources
// render with the same badges as context cards, and degraded banners.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import { sourceBadge } from "@/components/ContextCardView";
import type { AskPhase } from "@/hooks/useAsk";
import type { AskSource, ChatMessage } from "@/types/chat";

const ASK_STAGES = [
  { key: "keyword", label: "关键词提取" },
  { key: "searching", label: "搜索" },
  { key: "answer", label: "生成" },
] as const;

function stageState(
  stageKey: (typeof ASK_STAGES)[number]["key"],
  phase: AskPhase,
): "done" | "active" | "pending" {
  if (phase === "idle" || phase === "error") return "pending";
  const order = ["keyword", "searching", "answer"] as const;
  // degraded：搜索已完成但来源不足，停在「生成」阶段并由横幅接管说明。
  const phaseIndex = phase === "degraded" ? 2 : order.indexOf(phase);
  const stageIndex = order.indexOf(stageKey);
  if (phaseIndex === -1) return "pending";
  if (stageIndex < phaseIndex) return "done";
  if (stageIndex === phaseIndex) return "active";
  return "pending";
}

interface StageProgressProps {
  phase: AskPhase;
}

function StageProgress({ phase }: StageProgressProps): ReactElement {
  return (
    <div className="flex items-center gap-1.5" aria-label="询问阶段进度">
      {ASK_STAGES.map((stage, index) => {
        const state = stageState(stage.key, phase);
        const tone =
          state === "active"
            ? "border-blue-500 bg-blue-950/60 text-blue-200"
            : state === "done"
              ? "border-neutral-700 bg-neutral-900 text-neutral-300"
              : "border-neutral-800 bg-transparent text-neutral-600";
        return (
          <span key={stage.key} className="flex items-center gap-1.5">
            {index > 0 ? <span aria-hidden className="text-neutral-700">→</span> : null}
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone} ${state === "active" ? "animate-pulse" : ""}`}
              aria-current={state === "active" ? "step" : undefined}
            >
              {stage.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

interface SourceLinksProps {
  sources: AskSource[];
}

function SourceLinks({ sources }: SourceLinksProps): ReactElement {
  // 与卡片来源同构：同一套 sourceBadge 徽标 + 截断标题链接。
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t border-neutral-700/70 pt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">来源</p>
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 truncate text-xs text-blue-300 underline decoration-blue-900 underline-offset-2 hover:text-blue-200"
        >
          <span className="shrink-0 rounded border border-blue-800 px-1 py-0.5 text-[10px] text-blue-300">
            {sourceBadge(source.sourceType)}
          </span>
          <span className="truncate">{source.title}</span>
        </a>
      ))}
    </div>
  );
}

interface AskBubbleProps {
  message: ChatMessage;
}

function AskBubble({ message }: AskBubbleProps): ReactElement {
  const isUser = message.role === "user";
  const baseBubble = "rounded-lg px-4 py-2 text-sm break-words whitespace-pre-wrap";

  if (isUser) {
    return (
      <div className="mr-2 flex justify-end">
        <div className={`${baseBubble} max-w-[80%] bg-blue-600 text-white`}>
          <time className="mb-1 block text-[10px] text-blue-200">{message.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
          {message.content}
        </div>
      </div>
    );
  }

  const degraded = message.isDegraded === true;
  const assistantVisual = degraded
    ? `${baseBubble} max-h-[60vh] max-w-[85%] overflow-y-auto border border-amber-700/70 bg-amber-950/30 text-amber-200`
    : `${baseBubble} max-h-[60vh] max-w-[85%] overflow-y-auto bg-neutral-800 text-white`;
  const assistantContent = message.isStreaming
    ? `${message.content}▍`
    : message.content;

  return (
    <div className="ml-2 flex justify-start">
      <div className="flex min-w-0 flex-col gap-1">
        {degraded ? (
          <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-300">
            降级 · 没找到可靠来源
          </span>
        ) : null}
        <div className={assistantVisual}>
          <div className="mb-1 flex items-center justify-between gap-4"><time className="text-[10px] text-neutral-500">{message.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><button type="button" onClick={() => void navigator.clipboard.writeText(message.content)} className="text-[10px] text-neutral-500 hover:text-white">复制</button></div>
          {message.content === "" && message.isStreaming ? (
            <p className="animate-pulse text-xs text-neutral-500">正在处理…</p>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown components={{ a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{assistantContent}</ReactMarkdown>
            </div>
          )}
          {message.sources && message.sources.length > 0 ? (
            <SourceLinks sources={message.sources} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface AskPanelProps {
  messages: ChatMessage[];
  phase: AskPhase;
  busy: boolean;
  sendQuestion: (question: string, options?: { termHint?: string }) => Promise<void>;
  error: string | null;
  stopGenerating: () => void;
  retryLastFailed: () => void;
  canRetry: boolean;
  /** 外部预填（批次三：转写标注点击）。变化时填入输入框，不自动发送。 */
  draftQuestion?: string;
  /** B 阶段：卡片「问更多」带入的术语提示——预填输入框并聚焦，提交时透传 termHint。 */
  termHint?: string;
}

export default function AskPanel({
  messages,
  phase,
  busy,
  sendQuestion,
  error,
  stopGenerating,
  retryLastFailed,
  canRetry,
  draftQuestion,
  termHint,
}: AskPanelProps): ReactElement {
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState("");
  // 同一 draft 只消费一次（StrictMode / Fast Refresh 下 effect 会双跑）。
  const consumedDraftRef = useRef<string | null>(null);
  // 「问更多」术语提示：预填一次、聚焦一次；提交时透传一次后清空。
  const termHintRef = useRef<string>("");
  const consumedTermHintRef = useRef<string | null>(null);

  useEffect(() => {
    if (draftQuestion === undefined || draftQuestion === "") return;
    if (consumedDraftRef.current === draftQuestion) return;
    consumedDraftRef.current = draftQuestion;
    setInputValue(draftQuestion);
  }, [draftQuestion]);

  useEffect(() => {
    if (termHint === undefined || termHint === "") return;
    if (consumedTermHintRef.current === termHint) return;
    consumedTermHintRef.current = termHint;
    termHintRef.current = termHint;
    setInputValue(termHint);
    inputRef.current?.focus();
  }, [termHint]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submitFromInput = useCallback(async (): Promise<void> => {
    const text = inputValue.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setInputValue("");
    const hint = termHintRef.current;
    termHintRef.current = "";
    await sendQuestion(text, hint !== "" ? { termHint: hint } : undefined);
  }, [inputValue, busy, sendQuestion]);

  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 lg:tracking-widest">
          3. 会中询问
        </h2>
        <StageProgress phase={phase} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="flex flex-col gap-4" aria-live="polite">
            {messages.length === 0 ? (
              <>
                <div className="rounded-lg border border-neutral-800/90 bg-neutral-900/40 p-4 text-sm leading-relaxed text-neutral-500">
                  会议进行中有疑问？输入问题，本地模型联网检索后给出带来源的引用式回答。
                  一次一个问题，回答附带至少两条可追溯来源；来源不足会明确降级，不编造。
                </div>
                <p className="text-center text-sm text-neutral-600">
                  在下方输入你的问题。
                </p>
              </>
            ) : null}
            {messages.map((message) => (
              <AskBubble key={message.id} message={message} />
            ))}
            <div ref={scrollAnchorRef} aria-hidden />
          </div>
        </div>

        {error ? (
          <div className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-red-500">
            <span>{error}</span>
            {canRetry ? (
              <button type="button" onClick={retryLastFailed} disabled={busy} className="rounded border border-red-900 px-2 py-1 text-red-300 disabled:opacity-40">
                重试
              </button>
            ) : null}
          </div>
        ) : null}

        <footer className="shrink-0 border-t border-neutral-800 bg-[#0a0a0a]/95 px-5 py-4 backdrop-blur-sm">
          <div className="flex gap-3">
            <input
              id="ask-input"
              name="question"
              type="text"
              ref={inputRef}
              aria-label="输入询问问题"
              value={inputValue}
              onChange={(event) => {
                setInputValue(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitFromInput();
                }
              }}
              placeholder="输入问题，联网检索 + 本地生成引用式回答…"
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
            />
            <button
              type="button"
              aria-label={busy ? "停止生成" : "发送问题"}
              onClick={() => { if (busy) stopGenerating(); else void submitFromInput(); }}
              className={`shrink-0 rounded-md px-5 py-2.5 text-sm font-semibold text-white ${busy ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"}`}
            >
              {busy ? "停止" : "发送"}
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}
