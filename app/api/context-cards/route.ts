import { NextResponse } from "next/server";
import { generateOllamaJson } from "@/lib/ollama";
import { InsufficientSearchSourcesError, searchWeb, type SearchResult } from "@/lib/search";
import type { ContextCard } from "@/types/suggestions";

export const runtime = "nodejs";

interface ContextCardRequest {
  recentTranscript: string;
  knownKeywords: string[];
  transcriptChunkIds: string[];
  settings: {
    ollamaBaseUrl: string;
    ollamaModel: string;
    searchProvider: "tavily" | "bing" | "serpapi";
    searchApiKey: string;
  };
}

interface KeywordResponse {
  keyword: string;
}

interface CardResponse {
  keyword: string;
  explanation: string;
  whyNow: string;
}

export async function POST(
  request: Request,
): Promise<NextResponse<{ card: ContextCard } | { card: null; failure: { reason: string } }>> {
  const started = performance.now();
  const body = await readJson(request);
  const parsed = parseRequest(body);
  if (!parsed) return NextResponse.json({ card: null, failure: { reason: "Invalid context-card request" } }, { status: 400 });

  let keyword: string;
  let keywordMs = 0;
  try {
    const keywordStarted = performance.now();
    const result = await generateOllamaJson<KeywordResponse>({
      baseUrl: parsed.settings.ollamaBaseUrl,
      model: parsed.settings.ollamaModel,
      system: "从技术会议转写中识别一个此刻最值得补充背景的具体技术关键词。只返回 JSON：{\"keyword\":\"...\"}。不要返回泛化词。",
      prompt: `已知关键词：${parsed.knownKeywords.join(", ") || "无"}\n最近转写：${parsed.recentTranscript}`,
      timeoutMs: 5_000,
    });
    keywordMs = Math.round(performance.now() - keywordStarted);
    keyword = result.keyword.trim();
  } catch (caught) {
    return NextResponse.json({ card: null, failure: { reason: errorMessage(caught) } });
  }

  if (!isUsefulKeyword(keyword, parsed.knownKeywords)) {
    return NextResponse.json({ card: null, failure: { reason: "No new specific keyword detected" } });
  }

  const searchStarted = performance.now();
  let sources: SearchResult[];
  try {
    sources = await searchWithRetry(parsed, keyword);
  } catch (caught) {
    return NextResponse.json({ card: null, failure: { reason: errorMessage(caught) } });
  }
  const searchMs = Math.round(performance.now() - searchStarted);

  try {
    const generationStarted = performance.now();
    const generated = await generateOllamaJson<CardResponse>({
      baseUrl: parsed.settings.ollamaBaseUrl,
      model: parsed.settings.ollamaModel,
      system: "你是实时会议认知助手。根据会议片段和来源，生成可在几秒内读完的中文解释卡。只返回 JSON：{\"keyword\":\"...\",\"explanation\":\"一句话解释\",\"whyNow\":\"为什么现在相关\"}。不要编造来源未支持的事实。",
      prompt: [
        `会议片段：${parsed.recentTranscript}`,
        `关键词：${keyword}`,
        `来源：${sources.slice(0, 2).map((source, index) => `${index + 1}. ${source.title} ${source.snippet}`).join("\n")}`,
      ].join("\n\n"),
      timeoutMs: 8_000,
    });
    const generationMs = Math.round(performance.now() - generationStarted);
    const card = validateCard(generated, keyword, sources, parsed, {
      keyword: keywordMs,
      search: searchMs,
      generation: generationMs,
      total: Math.round(performance.now() - started),
    });
    return NextResponse.json({ card });
  } catch (caught) {
    return NextResponse.json({ card: null, failure: { reason: errorMessage(caught) } });
  }
}

async function searchWithRetry(request: ContextCardRequest, keyword: string): Promise<SearchResult[]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await searchWeb({
        provider: request.settings.searchProvider,
        apiKey: request.settings.searchApiKey,
        query: `${keyword} technology explanation`,
        timeoutMs: 4_000,
      });
    } catch (caught) {
      lastError = caught;
      if (!(caught instanceof InsufficientSearchSourcesError) && attempt === 0) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Search failed");
}

function validateCard(
  value: CardResponse,
  keyword: string,
  sources: SearchResult[],
  request: ContextCardRequest,
  latencyMs: ContextCard["latencyMs"],
): ContextCard {
  if (!isString(value.keyword) || !isString(value.explanation) || !isString(value.whyNow)) throw new Error("Ollama returned an invalid context card");
  return {
    id: crypto.randomUUID(),
    keyword: value.keyword.trim() || keyword,
    explanation: value.explanation.trim(),
    whyNow: value.whyNow.trim(),
    sources: [sources[0], sources[1]],
    createdAt: new Date(),
    transcriptChunkIds: request.transcriptChunkIds,
    latencyMs,
  };
}

function isUsefulKeyword(keyword: string, knownKeywords: string[]): boolean {
  const normalized = keyword.toLowerCase();
  return normalized.length >= 2 &&
    !["会议", "技术", "系统", "问题", "方案", "这个", "那个", "ai"].includes(normalized) &&
    !knownKeywords.some((known) => known.trim().toLowerCase() === normalized);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseRequest(value: unknown): ContextCardRequest | null {
  if (!isRecord(value) || !isString(value.recentTranscript) || !Array.isArray(value.knownKeywords) || !Array.isArray(value.transcriptChunkIds) || !isRecord(value.settings)) return null;
  if (!value.knownKeywords.every(isString) || !value.transcriptChunkIds.every(isString)) return null;
  if (!isString(value.settings.ollamaBaseUrl) || !isString(value.settings.ollamaModel) || !isString(value.settings.searchApiKey)) return null;
  const provider = value.settings.searchProvider;
  if (provider !== "tavily" && provider !== "bing" && provider !== "serpapi") return null;
  return {
    recentTranscript: value.recentTranscript.slice(-12_000),
    knownKeywords: value.knownKeywords,
    transcriptChunkIds: value.transcriptChunkIds,
    settings: {
      ollamaBaseUrl: value.settings.ollamaBaseUrl,
      ollamaModel: value.settings.ollamaModel,
      searchProvider: provider,
      searchApiKey: value.settings.searchApiKey,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Context card generation failed";
}
