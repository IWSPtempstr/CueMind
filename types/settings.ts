// User-editable Groq key, prompt templates, and transcript context window sizes persisted for the session.

export interface Settings {
  groqApiKey: string;
  apiKeyStorage: "local" | "session" | "memory";
  suggestionsPrompt: string;
  chatPrompt: string;
  summarizationPrompt: string;
  recentContextChars: number;
  earlierContextChars: number;
  chatContextChars: number;
  chunkIntervalSeconds: number;
  suggestionRefreshSeconds: number;
  transcriptionLanguage: string;
  localWhisperPath: string;
  localWhisperModelPath: string;
  localWhisperLanguage: "auto" | "zh" | "en";
  ollamaBaseUrl: string;
  ollamaModel: string;
  searchProvider: "tavily" | "bing" | "serpapi";
  searchApiKey: string;
  contextCardCooldownSeconds: number;
}
