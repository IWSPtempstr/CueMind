"use client";

// Full-screen overlay for editing Groq key, transcript context sizes, and prompt templates stored in localStorage.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import useSettings from "@/hooks/useSettings";
import { GROQ_API_KEY_HEADER } from "@/lib/prompts";

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
}

export default function SettingsModal({
  isOpen,
  onClose,
}: SettingsModalProps): ReactElement | null {
  const { settings, updateSetting, saveSettings, resetToDefaults } =
    useSettings();
  const panelRef = useRef<HTMLDivElement>(null);
  const groqKeyInputRef = useRef<HTMLInputElement>(null);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const [isTestingKey, setIsTestingKey] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      groqKeyInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen]);

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

  const testKey = useCallback(async (): Promise<void> => {
    setIsTestingKey(true);
    setKeyStatus(null);
    try {
      const headers = settings.groqApiKey.trim()
        ? { [GROQ_API_KEY_HEADER]: settings.groqApiKey.trim() }
        : undefined;
      const response = await fetch("/api/validate-key", { headers });
      const payload = (await response.json()) as { error?: unknown };
      setKeyStatus(
        response.ok
          ? "✓ Key works — the mic is cleared for takeoff."
          : typeof payload.error === "string"
            ? payload.error
            : "Key validation failed.",
      );
    } catch {
      setKeyStatus("Could not reach the validation service.");
    } finally {
      setIsTestingKey(false);
    }
  }, [settings.groqApiKey]);

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
              Settings
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
                htmlFor="settings-groq-key"
                className="text-sm font-medium text-neutral-200"
              >
                Groq API Key
              </label>
              <div className="flex gap-2">
                <input
                  ref={groqKeyInputRef}
                  id="settings-groq-key"
                  type="password"
                  autoComplete="off"
                  value={settings.groqApiKey}
                  onChange={(event) => {
                    updateSetting("groqApiKey", event.target.value);
                  }}
                  className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                  placeholder="Paste your Groq API key"
                />
                <button type="button" onClick={() => void testKey()} disabled={isTestingKey} className="rounded-md border border-neutral-600 px-3 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50">
                  {isTestingKey ? "Testing…" : "Test key"}
                </button>
              </div>
              <label htmlFor="settings-key-storage" className="text-xs font-medium text-neutral-400">Keep key for</label>
              <select
                id="settings-key-storage"
                value={settings.apiKeyStorage}
                onChange={(event) => updateSetting("apiKeyStorage", event.target.value as typeof settings.apiKeyStorage)}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200"
              >
                <option value="local">This browser</option>
                <option value="session">This tab session</option>
                <option value="memory">Until this page reloads</option>
              </select>
              <p className="text-xs leading-relaxed text-neutral-500">
                The browser sends your key only to this app&apos;s API proxy. Choose session or memory mode on a shared machine. You can also leave it blank when the server has GROQ_API_KEY configured.
              </p>
              {keyStatus ? <p className="text-xs text-blue-300" role="status">{keyStatus}</p> : null}
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <h3 className="text-sm font-medium text-neutral-200">
                Context Window Sizes
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="settings-recent-chars"
                    className="text-xs font-medium text-neutral-400"
                  >
                    Recent transcript (chars)
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
                    Earlier context (chars)
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
                    Chat transcript (chars)
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

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <h3 className="text-sm font-medium text-neutral-200">Recording & refresh</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  Audio chunk (seconds)
                  <input type="number" min={15} max={120} value={settings.chunkIntervalSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateSetting("chunkIntervalSeconds", Math.min(120, Math.max(15, value))); }} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  Suggestions (seconds)
                  <input type="number" min={15} max={300} value={settings.suggestionRefreshSeconds} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateSetting("suggestionRefreshSeconds", Math.min(300, Math.max(15, value))); }} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                  Transcription language
                  <select value={settings.transcriptionLanguage} onChange={(event) => updateSetting("transcriptionLanguage", event.target.value)} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
                    <option value="auto">Auto-detect</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="hi">Hindi</option>
                    <option value="ja">Japanese</option>
                    <option value="pt">Portuguese</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">本地 whisper.cpp</h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  桌面模式只读取本机路径，不上传音频；浏览器模式仍使用上面的 Groq 转写配置。
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
            </section>

            <section className="flex flex-col gap-4 border-b border-neutral-800 pb-8">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">实时认知卡片</h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  Ollama 在本机提取关键词和生成中文解释；搜索只发送关键词，不发送整段音频。
                </p>
              </div>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                Ollama 地址
                <input type="url" value={settings.ollamaBaseUrl} onChange={(event) => updateSetting("ollamaBaseUrl", event.target.value)} className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                Ollama 模型
                <input type="text" value={settings.ollamaModel} onChange={(event) => updateSetting("ollamaModel", event.target.value)} placeholder="qwen2.5:3b" className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200" />
              </label>
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
            </section>

            <section className="flex flex-col gap-4">
              <div>
                <h3 className="text-sm font-medium text-neutral-200">
                  Prompt Templates
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                  These are sent to the model on every request. Edit carefully —
                  they directly affect suggestion and chat quality.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-suggestions-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  Live Suggestions Prompt
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
                  htmlFor="settings-chat-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  Chat Prompt
                </label>
                <textarea
                  id="settings-chat-prompt"
                  rows={6}
                  value={settings.chatPrompt}
                  onChange={(event) => {
                    updateSetting("chatPrompt", event.target.value);
                  }}
                  className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 focus-visible:border-blue-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="settings-summarize-prompt"
                  className="text-xs font-medium text-neutral-400"
                >
                  Summarization Prompt
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
          </div>
        </div>

        <div className="shrink-0 border-t border-neutral-800 bg-neutral-900 p-8 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={resetToDefaults}
              className="rounded-md border border-neutral-600 bg-transparent px-4 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              Reset to Defaults
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
