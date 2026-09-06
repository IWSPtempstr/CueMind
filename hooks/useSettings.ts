"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ASK_PROMPT,
  CHAT_CONTEXT_CHARS,
  CHUNK_INTERVAL_SECONDS,
  EARLIER_CONTEXT_CHARS,
  LEGACY_DEFAULT_CHAT_PROMPT,
  MAX_CHUNK_INTERVAL_SECONDS,
  MAX_CONTEXT_CHARS,
  MAX_SUGGESTION_REFRESH_SECONDS,
  MIN_CADENCE_SECONDS,
  RECENT_CONTEXT_CHARS,
  SUGGESTION_REFRESH_SECONDS,
  SUGGESTIONS_PROMPT,
  SUMMARIZATION_PROMPT,
} from "@/lib/prompts";
import type { Settings } from "@/types/settings";

const STORAGE_KEY = "cuemind_settings";
// M3-a：转写导出三档开关使用独立 localStorage 键（需求指定），读取时优先于 cuemind_settings blob。
export const EXPORT_TRANSCRIPT_STORAGE_KEY = "cuemind_export_transcript";

type SecretName = "llamaCpp" | "remoteApi" | "search";

const SECRET_KEYS: Record<SecretName, { local: string; session: string }> = {
  llamaCpp: { local: "cuemind_llama_cpp_api_key", session: "cuemind_session_llama_cpp_api_key" },
  remoteApi: { local: "cuemind_remote_api_api_key", session: "cuemind_session_remote_api_api_key" },
  search: { local: "cuemind_search_api_key", session: "cuemind_session_search_api_key" },
};

const memorySecrets: Record<SecretName, string> = {
  llamaCpp: "",
  remoteApi: "",
  search: "",
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function storageMode(value: unknown): Settings["apiKeyStorage"] {
  return value === "session" || value === "memory" ? value : "local";
}

/**
 * 转写导出三档：独立键 cuemind_export_transcript 优先，缺省回退 cuemind_settings blob
 * 内的旧值（迁移），最终缺省 "folded"。
 */
function readExportTranscriptPreference(blob: Record<string, unknown>): Settings["exportTranscript"] {
  if (typeof window !== "undefined") {
    const standalone = localStorage.getItem(EXPORT_TRANSCRIPT_STORAGE_KEY);
    if (standalone === "none" || standalone === "folded" || standalone === "full") return standalone;
  }
  return blob.exportTranscript === "none" || blob.exportTranscript === "full" ? blob.exportTranscript : "folded";
}

function readSecret(name: SecretName, mode: Settings["apiKeyStorage"]): string {
  if (mode === "memory") return memorySecrets[name];
  if (mode === "session") return sessionStorage.getItem(SECRET_KEYS[name].session) ?? "";
  return localStorage.getItem(SECRET_KEYS[name].local) ?? "";
}

function writeSecret(name: SecretName, mode: Settings["apiKeyStorage"], value: string): void {
  if (mode === "local") localStorage.setItem(SECRET_KEYS[name].local, value);
  if (mode === "session") sessionStorage.setItem(SECRET_KEYS[name].session, value);
  if (mode === "memory") memorySecrets[name] = value;
}

function clearSecret(name: SecretName): void {
  localStorage.removeItem(SECRET_KEYS[name].local);
  sessionStorage.removeItem(SECRET_KEYS[name].session);
  memorySecrets[name] = "";
}

export function getDefaultSettings(): Settings {
  return {
    apiKeyStorage: "local",
    suggestionsPrompt: SUGGESTIONS_PROMPT,
    askPrompt: ASK_PROMPT,
    summarizationPrompt: SUMMARIZATION_PROMPT,
    recentContextChars: RECENT_CONTEXT_CHARS,
    earlierContextChars: EARLIER_CONTEXT_CHARS,
    chatContextChars: CHAT_CONTEXT_CHARS,
    chunkIntervalSeconds: CHUNK_INTERVAL_SECONDS,
    suggestionRefreshSeconds: SUGGESTION_REFRESH_SECONDS,
    transcriptionLanguage: "zh",
    // CUDA build configured for the current WSL host; existing saved settings remain authoritative.
    localWhisperPath: "/home/work/asr/whisper.cpp/build-cuda/bin/whisper-cli",
    localWhisperModelPath: "/home/work/asr/.runtime/models/ggml-small.bin",
    localWhisperLanguage: "zh",
    meetingTopic: "",
    domainGlossary: "",
    enableVad: true,
    vadModelPath: "/home/work/asr/.runtime/models/ggml-silero-v5.1.2.bin",
    modelProvider: "llama.cpp",
    llamaCppBaseUrl: "http://127.0.0.1:8082",
    llamaCppModel: "/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf",
    llamaCppApiKey: "",
    remoteApiBaseUrl: "",
    remoteApiModel: "",
    remoteApiApiKey: "",
    searchProvider: "tavily",
    searchApiKey: "",
    enableAgentReachFallback: true,
    contextCardCooldownSeconds: 20,
    exportTranscript: "folded",
    vaultPath: "",
  };
}

/** Reads saved preferences and completes the one-time legacy key migration. */
export function loadCueMindSettings(): Settings {
  const defaults = getDefaultSettings();
  if (typeof window === "undefined") return defaults;

  const raw = localStorage.getItem(STORAGE_KEY);
  let o: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        o = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt preferences fall back safely.
    }
  }

  const mode = storageMode(o.apiKeyStorage);

  // 旧键迁移 + 已迁移存储自愈：askPrompt 缺失时回退读取旧 chatPrompt 值。
  // 提交 1 的迁移曾把旧出厂默认（自由对话式契约）原样迁成 askPrompt，导致
  // /api/ask 生成自由文本、schema 校验失败；因此存量值等于旧默认的一律升级
  // 为新的引用式契约（幂等自愈），用户自定义（≠旧默认）原样保留。
  const storedAskPrompt =
    typeof o.askPrompt === "string" ? o.askPrompt : typeof o.chatPrompt === "string" ? o.chatPrompt : defaults.askPrompt;
  const askPromptSelfHealed = typeof o.askPrompt === "string" && o.askPrompt === LEGACY_DEFAULT_CHAT_PROMPT;
  const askPrompt = storedAskPrompt === LEGACY_DEFAULT_CHAT_PROMPT ? defaults.askPrompt : storedAskPrompt;

  const settings: Settings = {
    apiKeyStorage: mode,
    suggestionsPrompt: typeof o.suggestionsPrompt === "string" ? o.suggestionsPrompt : defaults.suggestionsPrompt,
    askPrompt,
    summarizationPrompt: typeof o.summarizationPrompt === "string" ? o.summarizationPrompt : defaults.summarizationPrompt,
    recentContextChars: clampInt(o.recentContextChars, defaults.recentContextChars, 1, MAX_CONTEXT_CHARS),
    earlierContextChars: clampInt(o.earlierContextChars, defaults.earlierContextChars, 1, MAX_CONTEXT_CHARS),
    chatContextChars: clampInt(o.chatContextChars, defaults.chatContextChars, 1, MAX_CONTEXT_CHARS),
    chunkIntervalSeconds: clampInt(o.chunkIntervalSeconds, defaults.chunkIntervalSeconds, MIN_CADENCE_SECONDS, MAX_CHUNK_INTERVAL_SECONDS),
    suggestionRefreshSeconds: clampInt(o.suggestionRefreshSeconds, defaults.suggestionRefreshSeconds, MIN_CADENCE_SECONDS, MAX_SUGGESTION_REFRESH_SECONDS),
    transcriptionLanguage: typeof o.transcriptionLanguage === "string" ? o.transcriptionLanguage : "zh",
    localWhisperPath: typeof o.localWhisperPath === "string" ? o.localWhisperPath : defaults.localWhisperPath,
    localWhisperModelPath: typeof o.localWhisperModelPath === "string" ? o.localWhisperModelPath : defaults.localWhisperModelPath,
    localWhisperLanguage: o.localWhisperLanguage === "zh" || o.localWhisperLanguage === "en" ? o.localWhisperLanguage : "zh",
    meetingTopic: typeof o.meetingTopic === "string" ? o.meetingTopic : defaults.meetingTopic,
    domainGlossary: typeof o.domainGlossary === "string" ? o.domainGlossary : defaults.domainGlossary,
    enableVad: o.enableVad !== false,
    vadModelPath: typeof o.vadModelPath === "string" ? o.vadModelPath : defaults.vadModelPath,
    modelProvider: o.modelProvider === "remote-api" ? "remote-api" : "llama.cpp",
    llamaCppBaseUrl: typeof o.llamaCppBaseUrl === "string" ? o.llamaCppBaseUrl : defaults.llamaCppBaseUrl,
    llamaCppModel: typeof o.llamaCppModel === "string" ? o.llamaCppModel : defaults.llamaCppModel,
    llamaCppApiKey: readSecret("llamaCpp", mode),
    remoteApiBaseUrl: typeof o.remoteApiBaseUrl === "string" ? o.remoteApiBaseUrl : defaults.remoteApiBaseUrl,
    remoteApiModel: typeof o.remoteApiModel === "string" ? o.remoteApiModel : defaults.remoteApiModel,
    remoteApiApiKey: readSecret("remoteApi", mode),
    searchProvider: o.searchProvider === "bing" || o.searchProvider === "serpapi" ? o.searchProvider : "tavily",
    searchApiKey: readSecret("search", mode) || (typeof o.searchApiKey === "string" ? o.searchApiKey : defaults.searchApiKey),
    enableAgentReachFallback: o.enableAgentReachFallback !== false,
    contextCardCooldownSeconds: clampInt(o.contextCardCooldownSeconds, defaults.contextCardCooldownSeconds, 5, 300),
    exportTranscript: readExportTranscriptPreference(o),
    vaultPath: typeof o.vaultPath === "string" ? o.vaultPath : defaults.vaultPath,
  };

  // One-time migration only: fold a legacy embedded search key into the chosen
  // store and strip the secret from the preferences blob. Later reads touch
  // nothing unless a legacy field is still present.
  if ("searchApiKey" in o) {
    if (!readSecret("search", "local") && settings.searchApiKey.trim()) {
      writeSecret("search", "local", settings.searchApiKey);
    }
    persistPreferences(settings);
  }
  // One-time migration only: rename the legacy chatPrompt key onto askPrompt.
  // settings.askPrompt already carries the migrated value when the new key is
  // absent; persisting drops chatPrompt from the blob. Also self-heals blobs
  // already migrated with the legacy default: persisting stores the new
  // citation-contract default. Idempotent — once repaired, later reads find
  // askPrompt !== LEGACY_DEFAULT_CHAT_PROMPT and touch nothing.
  if ("chatPrompt" in o || askPromptSelfHealed) {
    persistPreferences(settings);
  }
  return settings;
}

function persistPreferences(settings: Settings): void {
  const preferences: Record<string, unknown> = { ...settings };
  delete preferences.llamaCppApiKey;
  delete preferences.remoteApiApiKey;
  delete preferences.searchApiKey;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  // 需求契约：三档值同步到独立键，导出链路读取该键。
  localStorage.setItem(EXPORT_TRANSCRIPT_STORAGE_KEY, settings.exportTranscript);
}

function persistSettings(settings: Settings): void {
  clearSecret("llamaCpp");
  clearSecret("remoteApi");
  clearSecret("search");

  writeSecret("llamaCpp", settings.apiKeyStorage, settings.llamaCppApiKey);
  writeSecret("remoteApi", settings.apiKeyStorage, settings.remoteApiApiKey);
  writeSecret("search", settings.apiKeyStorage, settings.searchApiKey);
  persistPreferences(settings);
}

export default function useSettings(): {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  saveSettings: () => void;
  resetToDefaults: () => void;
} {
  const [settings, setSettings] = useState<Settings>(getDefaultSettings);

  useEffect(() => setSettings(loadCueMindSettings()), []);

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]): void => {
    setSettings((previous) => ({ ...previous, [key]: value }));
  }, []);

  const saveSettings = useCallback((): void => persistSettings(settings), [settings]);
  const resetToDefaults = useCallback((): void => setSettings(getDefaultSettings()), []);

  return { settings, updateSetting, saveSettings, resetToDefaults };
}
