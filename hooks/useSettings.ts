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
const LOCAL_KEY = "cuemind_groq_api_key";
const SESSION_KEY = "cuemind_session_groq_api_key";
const LEGACY_GROQ_KEY = "groq_api_key";
let memoryApiKey = "";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function storageMode(value: unknown): Settings["apiKeyStorage"] {
  return value === "session" || value === "memory" ? value : "local";
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
  };
}

function keyForMode(mode: Settings["apiKeyStorage"]): string {
  if (mode === "memory") return memoryApiKey;
  if (mode === "session") return sessionStorage.getItem(SESSION_KEY) ?? "";
  return localStorage.getItem(LOCAL_KEY) ?? "";
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
    groqApiKey: keyForMode(mode) || legacyKey,
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
  };

  // One-time migration only: fold a legacy or embedded key into the chosen store
  // and strip the secret from the preferences blob. Once clean, later reads touch
  // nothing — a load should not keep rewriting storage on every request.
  if (legacyRaw !== null || "groqApiKey" in o) {
    if (!localStorage.getItem(LOCAL_KEY) && legacyKey.trim()) {
      localStorage.setItem(LOCAL_KEY, legacyKey);
    }
    localStorage.removeItem(LEGACY_GROQ_KEY);
    persistPreferences(settings);
  }
  return settings;
}

function persistPreferences(settings: Settings): void {
  const { groqApiKey: _secret, ...preferences } = settings;
  void _secret;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

function persistSettings(settings: Settings): void {
  localStorage.removeItem(LEGACY_GROQ_KEY);
  localStorage.removeItem(LOCAL_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  memoryApiKey = "";

  if (settings.apiKeyStorage === "local") localStorage.setItem(LOCAL_KEY, settings.groqApiKey);
  if (settings.apiKeyStorage === "session") sessionStorage.setItem(SESSION_KEY, settings.groqApiKey);
  if (settings.apiKeyStorage === "memory") memoryApiKey = settings.groqApiKey;
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
