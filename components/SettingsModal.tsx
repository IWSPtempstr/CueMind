"use client";

// Full-screen overlay for editing runtime, local model, and prompt settings.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import HealthPanel, { type HealthSnapshot } from "@/components/HealthPanel";
import useSettings from "@/hooks/useSettings";
import type { Settings } from "@/types/settings";

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector =
    "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 决策 68：实时健康指标折叠区的数据（与旧右栏 HealthPanel 同一数据流）。 */
  health?: HealthSnapshot;
}

export default function SettingsModal({
  isOpen,
  onClose,
  health,
}: SettingsModalProps): ReactElement | null {
  const { settings, updateSetting, saveSettings, resetToDefaults } =
    useSettings();
  const panelRef = useRef<HTMLDivElement>(null);
  // 折叠区展开才渲染健康内容——展开期间随页面渲染实时刷新，收起即停止。
  const [healthOpen, setHealthOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  const handleSave = useCallback((): void => {
    saveSettings();
    onClose();
  }, [saveSettings, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-neutral-900"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
      >
        <div className="shrink-0 border-b border-neutral-800 p-8 pb-6">
          <div className="flex items-start justify-between gap-4">
            <h2
              id="settings-title"
              className="text-lg font-semibold text-neutral-100"
            >
              设置
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-transparent px-2 py-1 text-neutral-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              aria-label="Close settings"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-8 pt-6">
          <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3 border-b border-neutral-800 pb-8">
              <label
                htmlFor="settings-key-storage"
                className="text-sm font-medium text-neutral-200"
              >
                Key 保存范围
              </label>
              <select
                id="settings-key-storage"
                value={settings.apiKeyStorage}
                onChange={(event) => updateSetting("apiKeyStorage", event.target.value as typeof settings.apiKeyStorage)}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
              >
                <option value="local">此浏览器</option>
                <option value="session">此标签页会话</option>
                <option value="memory">直到页面刷新</option>
              </select>
              <p className="text-xs leading-relaxed text-neutral-500">
                该范围适用于下方所有 API Key（模型、搜索）。共享设备建议使用会话或内存模式。
              </p>
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <h3 className="text-sm font-medium text-neutral-200">
                上下文窗口
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="settings-recent-chars"
                    className="text-xs font-medium text-neutral-400"
                  >
                    最近转写（字符数）
                  </label>
                  <input
                    id="settings-recent-chars"
                    type="number"
                    min={1}
                    max={32000}
                    value={settings.recentContextChars}
                    onChange={(event) => {
                      const n = Number.parseInt(event.target.value, 10);
                      if (!Number.isNaN(n) && n >= 1) {
                        updateSetting("recentContextChars", Math.min(32000, n));
                      }
                    }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                  />
                  <p className="text-[11px] leading-snug text-neutral-600">
                    Verbatim tail of the transcript sent to live suggestions.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="settings-earlier-chars"
                    className="text-xs font-medium text-neutral-400"
                  >
                    更早上下文（字符数）
                  </label>
                  <input
                    id="settings-earlier-chars"
                    type="number"
                    min={1}
                    max={32000}
                    value={settings.earlierContextChars}
                    onChange={(event) => {
                      const n = Number.parseInt(event.target.value, 10);
                      if (!Number.isNaN(n) && n >= 1) {
                        updateSetting("earlierContextChars", Math.min(32000, n));
                      }
                    }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                  />
                  <p className="text-[11px] leading-snug text-neutral-600">
                    Older transcript summarized before the recent window.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="settings-chat-chars"
                    className="text-xs font-medium text-neutral-400"
                  >
                    对话上下文（字符数）
                  </label>
                  <input
                    id="settings-chat-chars"
                    type="number"
                    min={1}
                    max={32000}
                    value={settings.chatContextChars}
                    onChange={(event) => {
                      const n = Number.parseInt(event.target.value, 10);
                      if (!Number.isNaN(n) && n >= 1) {
                        updateSetting("chatContextChars", Math.min(32000, n));
                      }
                    }}
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                  />
                  <p className="text-[11px] leading-snug text-neutral-600">
                    Full transcript tail passed into chat as meeting context.
                  </p>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3 border-b border-neutral-800 pb-8">
              <details
                onToggle={(event) => setHealthOpen(event.currentTarget.open)}
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
              >
                <summary className="cursor-pointer select-none text-sm font-medium text-neutral-200">
                  实时健康指标
                </summary>
                {healthOpen && health ? (
                  <div className="mt-4">
                    <HealthPanel
                      asrStatus={health.asrStatus}
                      uploadStatus={health.uploadStatus}
                      cardCount={health.cardCount}
                      failureCount={health.failureCount}
                      latestTotalLatencyMs={health.latestTotalLatencyMs}
                      latencySummaries={health.latencySummaries}
                      queueStatus={health.queueStatus}
                      degradationStatus={health.degradationStatus}
                    />
                  </div>
                ) : null}
              </details>
              <p className="text-xs leading-relaxed text-neutral-500">
                ASR 状态、窗口延迟与卡片统计；展开期间实时刷新，收起停止更新。
              </p>
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <h3 className="text-sm font-medium text-neutral-200">录音与刷新</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  音频片段（秒）
                  <input type="number" min={15} max={120} value={settings.chunkIntervalSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateSetting("chunkIntervalSeconds", Math.min(120, Math.max(15, value))); }} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  建议刷新（秒）
                  <input type="number" min={15} max={300} value={settings.suggestionRefreshSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateSetting("suggestionRefreshSeconds", Math.min(300, Math.max(15, value))); }} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  浏览器转写语言
                  <select value={settings.transcriptionLanguage} onChange={(event) => updateSetting("transcriptionLanguage", event.target.value)} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
                    <option value="auto">自动识别</option>
                    <option value="zh">中文</option>
                    <option value="en">英文</option>
                    <option value="es">西班牙文</option>
                    <option value="fr">法文</option>
                    <option value="de">德文</option>
                    <option value="hi">印地文</option>
                    <option value="ja">日文</option>
                    <option value="pt">葡萄牙文</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">本地 whisper.cpp</h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  桌面模式与浏览器麦克风转写都只读取本机路径、在本机完成转写，不上传音频；请填写 whisper.cpp 可执行文件与模型路径。
                </p>
              </div>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                whisper.cpp 可执行文件路径
                <input
                  type="text"
                  value={settings.localWhisperPath}
                  onChange={(event) => updateSetting("localWhisperPath", event.target.value)}
                  placeholder="C:\\Tools\\whisper.cpp\\whisper-cli.exe"
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                whisper 模型路径
                <input
                  type="text"
                  value={settings.localWhisperModelPath}
                  onChange={(event) => updateSetting("localWhisperModelPath", event.target.value)}
                  placeholder="C:\\Models\\ggml-base.bin"
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                本地转写语言
                <select
                  value={settings.localWhisperLanguage}
                  onChange={(event) => updateSetting("localWhisperLanguage", event.target.value as typeof settings.localWhisperLanguage)}
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                >
                  <option value="auto">自动识别</option>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                会议主题
                <input
                  type="text"
                  value={settings.meetingTopic}
                  onChange={(event) => updateSetting("meetingTopic", event.target.value)}
                  placeholder="如：AI Agent 技术分享"
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="settings-domain-glossary" className="text-xs text-neutral-400">
                  领域术语库
                </label>
                <textarea
                  id="settings-domain-glossary"
                  rows={2}
                  value={settings.domainGlossary}
                  onChange={(event) => updateSetting("domainGlossary", event.target.value)}
                  placeholder="逗号分隔，如：Harness, Speculative Decoding, llama.cpp"
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
                <p className="text-[11px] leading-snug text-neutral-600">
                  作为转写初始提示词偏置模型输出，提高专有名词识别准确率。
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={settings.enableVad}
                  onChange={(event) => updateSetting("enableVad", event.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-950 text-blue-600"
                />
                启用 VAD 语音检测
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                VAD 模型路径
                <input
                  type="text"
                  value={settings.vadModelPath}
                  onChange={(event) => updateSetting("vadModelPath", event.target.value)}
                  placeholder="/home/work/asr/.runtime/models/ggml-silero-v5.1.2.bin"
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                />
              </label>
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">实时认知卡片</h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  本地 llama.cpp 或显式配置的远端 OpenAI-compatible API 提取关键词并生成中文解释；搜索只发送关键词，不发送整段音频。
                </p>
              </div>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                模型 Provider
                <select
                  value={settings.modelProvider}
                  onChange={(event) => updateSetting("modelProvider", event.target.value as typeof settings.modelProvider)}
                  className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
                >
                  <option value="llama.cpp">llama.cpp（本地）</option>
                  <option value="remote-api">远端 API</option>
                </select>
              </label>
              {settings.modelProvider === "llama.cpp" ? (
                <>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    llama-server 地址
                    <input type="url" value={settings.llamaCppBaseUrl} onChange={(event) => updateSetting("llamaCppBaseUrl", event.target.value)} placeholder="http://127.0.0.1:8082" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    本地模型路径
                    <input type="text" value={settings.llamaCppModel} onChange={(event) => updateSetting("llamaCppModel", event.target.value)} placeholder="/home/work/models/cuemind/Qwen3-4B-Instruct-Q4_K_M.gguf" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    本地 API Key（可选）
                    <input type="password" autoComplete="off" value={settings.llamaCppApiKey} onChange={(event) => updateSetting("llamaCppApiKey", event.target.value)} placeholder="留空表示无鉴权" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                </>
              ) : (
                <>
                  <p className="text-xs leading-relaxed text-neutral-500">
                    远端请求只发送最小化上下文（关键词与来源摘要），不上传整段音频或完整转写。
                  </p>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    远端 Base URL
                    <input type="url" value={settings.remoteApiBaseUrl} onChange={(event) => updateSetting("remoteApiBaseUrl", event.target.value)} placeholder="https://api.example.com/v1" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    远端模型
                    <input type="text" value={settings.remoteApiModel} onChange={(event) => updateSetting("remoteApiModel", event.target.value)} placeholder="model-name" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                    远端 API Key
                    <input type="password" autoComplete="off" value={settings.remoteApiApiKey} onChange={(event) => updateSetting("remoteApiApiKey", event.target.value)} placeholder="Paste API key" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                  </label>
                </>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  搜索 provider
                  <select value={settings.searchProvider} onChange={(event) => updateSetting("searchProvider", event.target.value as typeof settings.searchProvider)} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
                    <option value="tavily">Tavily</option>
                    <option value="bing">Bing</option>
                    <option value="serpapi">SerpAPI</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  卡片冷却（秒）
                  <input type="number" min={5} max={300} value={settings.contextCardCooldownSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateSetting("contextCardCooldownSeconds", Math.min(300, Math.max(5, value))); }} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                </label>
              </div>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                搜索 API Key
                <input type="password" autoComplete="off" value={settings.searchApiKey} onChange={(event) => updateSetting("searchApiKey", event.target.value)} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={settings.enableAgentReachFallback}
                  onChange={(event) => updateSetting("enableAgentReachFallback", event.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-950 text-blue-600"
                />
                Tavily 不可用时启用 agent-reach 降级
              </label>
              <p className="text-xs leading-relaxed text-neutral-500">
                服务端配置了 <code>TAVILY_API_KEY</code> 时优先使用服务端 Key；浏览器 Key 仅作为回退。
              </p>
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">
                Prompt 模板
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  这些内容会随每次请求发送给模型，请谨慎修改。
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-suggestions-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  实时建议 Prompt
                </label>
                <textarea
                  id="settings-suggestions-prompt"
                  rows={6}
                  value={settings.suggestionsPrompt}
                  onChange={(event) => {
                    updateSetting("suggestionsPrompt", event.target.value);
                  }}
                  className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-ask-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  会中询问提示词（askPrompt）
                </label>
                <textarea
                  id="settings-ask-prompt"
                  rows={6}
                  value={settings.askPrompt}
                  onChange={(event) => {
                    updateSetting("askPrompt", event.target.value);
                  }}
                  className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-summarize-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  总结 Prompt
                </label>
                <textarea
                  id="settings-summarize-prompt"
                  rows={6}
                  value={settings.summarizationPrompt}
                  onChange={(event) => {
                    updateSetting("summarizationPrompt", event.target.value);
                  }}
                  className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
              </div>
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">
                Vault 导出
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  会议笔记与概念卡片导出为本地 Markdown 文件（兼容 Obsidian 等工具）。
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-vault-path"
                  className="text-xs font-medium text-neutral-400"
                >
                  Vault 路径
                </label>
                <input
                  id="settings-vault-path"
                  type="text"
                  value={settings.vaultPath}
                  placeholder="留空使用服务端默认（数据目录/vault）"
                  onChange={(event) => {
                    updateSetting("vaultPath", event.target.value);
                  }}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
                <p className="text-xs text-neutral-600">
                  导出根目录（绝对路径），笔记写入其下的 cuemind/meetings/ 与 cuemind/concepts/；留空使用服务端默认。
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-export-transcript"
                  className="text-xs font-medium text-neutral-400"
                >
                  完整转写导出
                </label>
                <select
                  id="settings-export-transcript"
                  value={settings.exportTranscript}
                  onChange={(event) => {
                    updateSetting(
                      "exportTranscript",
                      event.target.value as Settings["exportTranscript"],
                    );
                  }}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                >
                  <option value="folded">折叠（默认，可展开）</option>
                  <option value="none">不导出（隐私最小化）</option>
                  <option value="full">完整平铺</option>
                </select>
                <p className="text-xs text-neutral-600">
                  仅作用于会议笔记的转写正文；概念卡片始终完整导出。
                </p>
              </div>
            </section>
          </div>
        </div>

        <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 p-8 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={resetToDefaults}
              className="rounded-md border border-neutral-600 bg-transparent px-4 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              恢复默认
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
