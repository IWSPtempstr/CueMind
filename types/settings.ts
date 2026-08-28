// User-editable prompt templates, local model paths, and transcript context window sizes persisted for the session.

export interface Settings {
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
  meetingTopic: string;
  domainGlossary: string;
  enableVad: boolean;
  vadModelPath: string;
  modelProvider: "llama.cpp" | "remote-api";
  llamaCppBaseUrl: string;
  llamaCppModel: string;
  llamaCppApiKey: string;
  remoteApiBaseUrl: string;
  remoteApiModel: string;
  remoteApiApiKey: string;
  searchProvider: "tavily" | "bing" | "serpapi";
  searchApiKey: string;
  enableAgentReachFallback: boolean;
  contextCardCooldownSeconds: number;
}
