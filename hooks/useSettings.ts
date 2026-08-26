"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CHAT_CONTEXT_CHARS,
  CHAT_PROMPT,
  CHUNK_INTERVAL_SECONDS,
  EARLIER_CONTEXT_CHARS,
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
const LEGACY_GROQ_KEY = "groq_api_key";

// The shipped Ollama defaults are only used to decide whether a persisted legacy
// value is a real user customization worth migrating, or the default we skip.
const LEGACY_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const LEGACY_OLLAMA_MODEL = "qwen2.5:3b";

type SecretName = "groq" | "llamaCpp" | "remoteApi";

const SECRET_KEYS: Record<SecretName, { local: string; session: string }> = {
  groq: { local: "cuemind_groq_api_key", session: "cuemind_session_groq_api_key" },
  llamaCpp: { local: "cuemind_llama_cpp_api_key", session: "cuemind_session_llama_cpp_api_key" },
  remoteApi: { local: "cuemind_remote_api_api_key", session: "cuemind_session_remote_api_api_key" },
};

const memorySecrets: Record<SecretName, string> = {
  groq: "",
  llamaCpp: "",
  remoteApi: "",
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function storageMode(value: unknown): Settings["apiKeyStorage"] {
  return value === "session" || value === "memory" ? value : "local";
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

function migrateLegacyString(
  legacy: unknown,
  current: unknown,
  legacyDefault: string,
  fallback: string,
): string {
  if (typeof legacy === "string" && legacy.trim() && legacy !== legacyDefault) return legacy;
  if (typeof current === "string" && current.trim()) return current;
  return fallback;
}

export function getDefaultSettings(): Settings {
  return {
    groqApiKey: "",
    apiKeyStorage: "local",
    suggestionsPrompt: SUGGESTIONS_PROMPT,
    chatPrompt: CHAT_PROMPT,
    summarizationPrompt: SUMMARIZATION_PROMPT,
    recentContextChars: RECENT_CONTEXT_CHARS,
    earlierContextChars: EARLIER_CONTEXT_CHARS,
    chatContextChars: CHAT_CONTEXT_CHARS,
    chunkIntervalSeconds: CHUNK_INTERVAL_SECONDS,
    suggestionRefreshSeconds: SUGGESTION_REFRESH_SECONDS,
    transcriptionLanguage: "auto",
    localWhisperPath: "",
    localWhisperModelPath: "",
    localWhisperLanguage: "auto",
    modelProvider: "llama.cpp",
    llamaCppBaseUrl: "http://127.0.0.1:8082",
    llamaCppModel: "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    llamaCppApiKey: "",
    remoteApiBaseUrl: "",
    remoteApiModel: "",
    remoteApiApiKey: "",
    ollamaBaseUrl: LEGACY_OLLAMA_BASE_URL,
    ollamaModel: LEGACY_OLLAMA_MODEL,
    searchProvider: "tavily",
    searchApiKey: "",
    contextCardCooldownSeconds: 20,
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
  const legacyRaw = localStorage.getItem(LEGACY_GROQ_KEY);
  const embeddedLegacyKey = typeof o.groqApiKey === "string" ? o.groqApiKey : "";
  const legacyKey = legacyRaw ?? embeddedLegacyKey;

  const settings: Settings = {
    groqApiKey: readSecret("groq", mode) || legacyKey,
    apiKeyStorage: mode,
    suggestionsPrompt: typeof o.suggestionsPrompt === "string" ? o.suggestionsPrompt : defaults.suggestionsPrompt,
    chatPrompt: typeof o.chatPrompt === "string" ? o.chatPrompt : defaults.chatPrompt,
    summarizationPrompt: typeof o.summarizationPrompt === "string" ? o.summarizationPrompt : defaults.summarizationPrompt,
    recentContextChars: clampInt(o.recentContextChars, defaults.recentContextChars, 1, MAX_CONTEXT_CHARS),
    earlierContextChars: clampInt(o.earlierContextChars, defaults.earlierContextChars, 1, MAX_CONTEXT_CHARS),
    chatContextChars: clampInt(o.chatContextChars, defaults.chatContextChars, 1, MAX_CONTEXT_CHARS),
    chunkIntervalSeconds: clampInt(o.chunkIntervalSeconds, defaults.chunkIntervalSeconds, MIN_CADENCE_SECONDS, MAX_CHUNK_INTERVAL_SECONDS),
    suggestionRefreshSeconds: clampInt(o.suggestionRefreshSeconds, defaults.suggestionRefreshSeconds, MIN_CADENCE_SECONDS, MAX_SUGGESTION_REFRESH_SECONDS),
    transcriptionLanguage: typeof o.transcriptionLanguage === "string" ? o.transcriptionLanguage : "auto",
    localWhisperPath: typeof o.localWhisperPath === "string" ? o.localWhisperPath : defaults.localWhisperPath,
    localWhisperModelPath: typeof o.localWhisperModelPath === "string" ? o.localWhisperModelPath : defaults.localWhisperModelPath,
    localWhisperLanguage: o.localWhisperLanguage === "zh" || o.localWhisperLanguage === "en" ? o.localWhisperLanguage : "auto",
    modelProvider: o.modelProvider === "remote-api" ? "remote-api" : "llama.cpp",
    llamaCppBaseUrl: migrateLegacyString(o.ollamaBaseUrl, o.llamaCppBaseUrl, LEGACY_OLLAMA_BASE_URL, defaults.llamaCppBaseUrl),
    llamaCppModel: migrateLegacyString(o.ollamaModel, o.llamaCppModel, LEGACY_OLLAMA_MODEL, defaults.llamaCppModel),
    llamaCppApiKey: readSecret("llamaCpp", mode),
    remoteApiBaseUrl: typeof o.remoteApiBaseUrl === "string" ? o.remoteApiBaseUrl : defaults.remoteApiBaseUrl,
    remoteApiModel: typeof o.remoteApiModel === "string" ? o.remoteApiModel : defaults.remoteApiModel,
    remoteApiApiKey: readSecret("remoteApi", mode),
    ollamaBaseUrl: typeof o.ollamaBaseUrl === "string" ? o.ollamaBaseUrl : defaults.ollamaBaseUrl,
    ollamaModel: typeof o.ollamaModel === "string" ? o.ollamaModel : defaults.ollamaModel,
    searchProvider: o.searchProvider === "bing" || o.searchProvider === "serpapi" ? o.searchProvider : "tavily",
    searchApiKey: typeof o.searchApiKey === "string" ? o.searchApiKey : defaults.searchApiKey,
    contextCardCooldownSeconds: clampInt(o.contextCardCooldownSeconds, defaults.contextCardCooldownSeconds, 5, 300),
  };

  // One-time migration only: fold a legacy or embedded Groq key into the chosen
  // store and strip the secret from the preferences blob. The ollama fields are
  // folded into the llama.cpp fields above and dropped from the persisted blob.
  // Later reads touch nothing unless a legacy field is still present.
  if (legacyRaw !== null || "groqApiKey" in o) {
    if (!readSecret("groq", "local") && legacyKey.trim()) {
      writeSecret("groq", "local", legacyKey);
    }
    localStorage.removeItem(LEGACY_GROQ_KEY);
    persistPreferences(settings);
  } else if ("ollamaBaseUrl" in o || "ollamaModel" in o) {
    persistPreferences(settings);
  }
  return settings;
}

function persistPreferences(settings: Settings): void {
  const preferences: Record<string, unknown> = { ...settings };
  delete preferences.groqApiKey;
  delete preferences.llamaCppApiKey;
  delete preferences.remoteApiApiKey;
  delete preferences.ollamaBaseUrl;
  delete preferences.ollamaModel;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

function persistSettings(settings: Settings): void {
  localStorage.removeItem(LEGACY_GROQ_KEY);
  clearSecret("groq");
  clearSecret("llamaCpp");
  clearSecret("remoteApi");

  writeSecret("groq", settings.apiKeyStorage, settings.groqApiKey);
  writeSecret("llamaCpp", settings.apiKeyStorage, settings.llamaCppApiKey);
  writeSecret("remoteApi", settings.apiKeyStorage, settings.remoteApiApiKey);
  persistPreferences(settings);
}

export function groqRequestHeaders(settings = loadCueMindSettings()): Record<string, string> {
  return settings.groqApiKey.trim()
    ? { "x-groq-api-key": settings.groqApiKey.trim() }
    : {};
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
