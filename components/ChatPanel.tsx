"use client";

// Right column: threaded chat with streaming assistant replies, suggestion handoff, and pinned composer.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage } from "@/types/chat";
import type { Suggestion } from "@/types/suggestions";

const FOLLOW_UP_PROMPTS = [
  "展开说明",
  "帮我组织回答",
  "我接下来该问什么？",
] as const;

interface InfoCardProps {
  children: ReactNode;
}

function InfoCard({ children }: InfoCardProps): ReactElement {
  return (
    <div className="rounded-lg border border-neutral-800/90 bg-neutral-900/40 p-4 text-sm leading-relaxed text-neutral-500">
      {children}
    </div>
  );
}

interface ChatPanelProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (
    message: string,
    options?: { skipUserMessage?: boolean },
  ) => Promise<void>;
  addSuggestionToChat: (suggestion: Suggestion) => void;
  error: string | null;
  pendingSuggestion: Suggestion | null;
  onSuggestionHandled: () => void;
  stopGenerating: () => void;
  retryLastFailed: () => void;
  canRetry: boolean;
}

interface ChatBubbleProps {
  message: ChatMessage;
}

function ChatBubble({ message }: ChatBubbleProps): ReactElement {
  const isUser = message.role === "user";
  const isDetail = message.isDetail === true;
  const baseBubble = "rounded-lg px-4 py-2 text-sm break-words whitespace-pre-wrap";

  if (isUser) {
    return (
      <div className="mr-2 flex justify-end">
        <div
          className={`${baseBubble} max-w-[80%] bg-blue-600 text-white`}
        >
          <time className="mb-1 block text-[10px] text-blue-200">{message.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
          {message.content}
          <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)} className="mt-2 block text-[10px] text-blue-200">复制</button>
        </div>
      </div>
    );
  }

  const assistantVisual = isDetail
    ? `${baseBubble} max-h-[60vh] max-w-[85%] overflow-y-auto border-l-2 border-blue-500 bg-neutral-800 text-neutral-300`
    : `${baseBubble} max-h-[60vh] max-w-[85%] overflow-y-auto bg-neutral-800 text-white`;
  const assistantContent = message.isStreaming
    ? `${message.content}▍`
    : message.content;

  return (
    <div className="ml-2 flex justify-start">
      <div className="flex flex-col gap-1">
        {isDetail ? (
          <span className="text-xs uppercase tracking-widest text-blue-400">
            快速预览
          </span>
        ) : null}
        <div className={assistantVisual}>
          <div className="mb-1 flex items-center justify-between gap-4"><time className="text-[10px] text-neutral-500">{message.timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time><button type="button" onClick={() => void navigator.clipboard.writeText(message.content)} className="text-[10px] text-neutral-500 hover:text-white">复制</button></div>
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown components={{ a: ({ ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>{assistantContent}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPanel({
  messages,
  isStreaming,
  sendMessage,
  addSuggestionToChat,
  error,
  pendingSuggestion,
  onSuggestionHandled,
  stopGenerating,
  retryLastFailed,
  canRetry,
}: ChatPanelProps): ReactElement {
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  // StrictMode / Fast Refresh 下挂载期 effect 会执行两次；同一 pendingSuggestion 对象只允许消费一次，
  // 否则会重复插入气泡并触发两次聊天流。
  const handledSuggestionRef = useRef<Suggestion | null>(null);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    if (pendingSuggestion === null || handledSuggestionRef.current === pendingSuggestion) {
      return;
    }
    handledSuggestionRef.current = pendingSuggestion;
    addSuggestionToChat(pendingSuggestion);
    onSuggestionHandled();
  }, [pendingSuggestion, addSuggestionToChat, onSuggestionHandled]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submitFromInput = useCallback(async (): Promise<void> => {
    const text = inputValue.trim();
    if (text.length === 0 || isStreaming) {
      return;
    }
    setInputValue("");
    await sendMessage(text);
  }, [inputValue, isStreaming, sendMessage]);

  return (
    <section className="flex h-[50vh] min-h-0 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:min-w-0 lg:flex-1 lg:shrink">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-4">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500 lg:tracking-widest">
          3. 对话（详细回答）
        </h2>
        <span className="rounded-full border border-neutral-700 bg-neutral-900/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
          仅当前会话
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="flex flex-col gap-4" aria-live="polite">
            {messages.length === 0 ? (
              <>
                <InfoCard>
                  这里用于承载较长回答和追问。建议需要展开时可以交给对话，
                  也可以直接输入新问题；内容只保存在当前会话中。
                </InfoCard>
                <p className="text-center text-sm text-neutral-600">
                  点击建议，或在下方输入问题。
                </p>
              </>
            ) : null}
            {messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
            <div ref={scrollAnchorRef} aria-hidden />
          </div>
        </div>

        {error ? (
          <div className="flex shrink-0 items-center gap-2 px-5 pb-2 text-xs text-red-500">
            <span>{error}</span>
            {canRetry ? (
              <button type="button" onClick={retryLastFailed} className="rounded border border-red-900 px-2 py-1 text-red-300">
                重试
              </button>
            ) : null}
          </div>
        ) : null}

        <footer className="shrink-0 border-t border-neutral-800 bg-[#0a0a0a]/95 px-5 py-4 backdrop-blur-sm">
          {messages.some((message) => message.isDetail) ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {FOLLOW_UP_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={isStreaming}
                  onClick={() => void sendMessage(prompt)}
                  className="rounded-full border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-400 hover:text-white disabled:opacity-40"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-3">
            <input
              id="chat-input"
              name="message"
              type="text"
              aria-label="输入消息"
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
              placeholder="输入你想追问的内容…"
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              aria-label={isStreaming ? "停止生成" : "发送消息"}
              onClick={() => { if (isStreaming) stopGenerating(); else void submitFromInput(); }}
              className={`shrink-0 rounded-md px-5 py-2.5 text-sm font-semibold text-white ${isStreaming ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"}`}
            >
              {isStreaming ? "停止" : "发送"}
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}
