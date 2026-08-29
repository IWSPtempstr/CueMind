// Vault export route (M3-a write direction).
// POST { kind: "meeting", snapshot, cards?, exportTranscript?, vaultPath?, asrModel? }
//   → write cuemind/meetings/<date>-<topic>.md (immutable after first write)
// POST { kind: "concept", card, candidateId, sessionId?, vaultPath? }
//   → write/append cuemind/concepts/<term>.md (never overwrites user edits)
// Responses: { saved: true, file } | { skipped: "already-exported" | "user-edited-appended" }.
// The vault is the ONLY destination — no cloud endpoints (decision 63). Side-channel
// only: callers are fire-and-forget and swallow errors.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getCandidate } from "@/lib/candidate-store";
import type { AskExchange } from "@/lib/ask-history";
import type { AskSource } from "@/types/chat";
import {
  exportConceptToVault,
  exportMeetingToVault,
  resolveVaultRoot,
  type ConceptCardInput,
  type MeetingMarkdownArgs,
  type VaultConceptSource,
  type VaultMeetingChunk,
  type VaultTranscriptMode,
} from "@/lib/vault-exporter";

export const runtime = "nodejs";

const MAX_CHUNKS = 20_000;
const MAX_CHUNK_CHARS = 20_000;
const MAX_CARDS = 500;
const MAX_SOURCES = 50;
const MAX_KEY_POINTS = 20;
const MAX_FIELD_CHARS = 8_000;
const MAX_ASKS = 200;
const MAX_ASK_QUESTION_CHARS = 500;
const MAX_ASK_ANSWER_CHARS = 2_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractTranscriptMode(value: unknown): VaultTranscriptMode {
  return value === "none" || value === "full" ? value : "folded";
}

function buildMeetingArgs(snapshot: Record<string, unknown>): MeetingMarkdownArgs | null {
  const id = nonEmptyString(snapshot.id);
  const title = nonEmptyString(snapshot.title);
  if (id === null || title === null) return null;

  if (!Array.isArray(snapshot.transcriptChunks)) return null;
  const chunks: VaultMeetingChunk[] = [];
  for (const raw of snapshot.transcriptChunks.slice(0, MAX_CHUNKS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const text = record.text;
    if (typeof text !== "string" || text.length === 0) continue;
    const chunkId = nonEmptyString(record.id);
    const chunkSource = nonEmptyString(record.source);
    const startMs = typeof record.startMs === "number" && Number.isFinite(record.startMs) ? record.startMs : undefined;
    const endMs = typeof record.endMs === "number" && Number.isFinite(record.endMs) ? record.endMs : undefined;
    chunks.push({
      ...(chunkId !== null ? { id: chunkId } : {}),
      text: text.slice(0, MAX_CHUNK_CHARS),
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
      ...(chunkSource !== null ? { source: chunkSource } : {}),
    });
  }

  let meetingReport: { content: string } | null = null;
  if (typeof snapshot.meetingReport === "object" && snapshot.meetingReport !== null) {
    const content = (snapshot.meetingReport as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim().length > 0) {
      meetingReport = { content };
    }
  }

  const cards: MeetingMarkdownArgs["cards"] = [];
  if (Array.isArray(snapshot.cards)) {
    for (const raw of snapshot.cards.slice(0, MAX_CARDS)) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const keyword = nonEmptyString(record.keyword);
      const candidateId = nonEmptyString(record.candidateId);
      if (keyword === null || candidateId === null) continue;
      cards.push({ keyword, candidateId });
    }
  }

  return {
    id,
    title,
    topicSummary: nonEmptyString(snapshot.topicSummary),
    createdAt: nonEmptyString(snapshot.createdAt) ?? new Date().toISOString(),
    transcriptChunks: chunks,
    meetingReport,
    cards,
    asrModel: nonEmptyString(snapshot.asrModel),
  };
}

function extractSources(value: unknown): VaultConceptSource[] {
  if (!Array.isArray(value)) return [];
  const sources: VaultConceptSource[] = [];
  for (const raw of value.slice(0, MAX_SOURCES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const title = nonEmptyString(record.title) ?? "";
    const url = nonEmptyString(record.url);
    if (url === null) continue;
    const snippet = nonEmptyString(record.snippet);
    const sourceType = nonEmptyString(record.sourceType);
    sources.push({
      title: title.slice(0, 500),
      url,
      ...(snippet !== null ? { snippet: snippet.slice(0, MAX_FIELD_CHARS) } : {}),
      ...(sourceType !== null ? { sourceType } : {}),
    });
  }
  return sources;
}

function extractAskSources(value: unknown): AskSource[] {
  if (!Array.isArray(value)) return [];
  const sources: AskSource[] = [];
  for (const raw of value.slice(0, MAX_SOURCES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = nonEmptyString(record.url);
    if (url === null) continue;
    const title = nonEmptyString(record.title) ?? url;
    const sourceType = nonEmptyString(record.sourceType);
    sources.push({
      title: title.slice(0, 500),
      url,
      ...(sourceType !== null ? { sourceType } : {}),
    });
  }
  return sources;
}

function buildAskExchanges(value: unknown): AskExchange[] {
  if (!Array.isArray(value)) return [];
  const asks: AskExchange[] = [];
  for (const raw of value.slice(0, MAX_ASKS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const question = nonEmptyString(record.question);
    const answer = nonEmptyString(record.answer);
    if (question === null || answer === null) continue;
    const sources = extractAskSources(record.sources);
    asks.push({
      question: question.slice(0, MAX_ASK_QUESTION_CHARS),
      answer: answer.slice(0, MAX_ASK_ANSWER_CHARS),
      ...(sources.length > 0 ? { sources } : {}),
    });
  }
  return asks;
}

function buildConceptArgs(card: Record<string, unknown>): ConceptCardInput | null {
  const candidateId = nonEmptyString(card.candidateId);
  const keyword = nonEmptyString(card.keyword);
  if (candidateId === null || keyword === null) return null;

  const keyPoints = Array.isArray(card.keyPoints)
    ? card.keyPoints.filter((point): point is string => typeof point === "string" && point.trim().length > 0).slice(0, MAX_KEY_POINTS).map((point) => point.slice(0, MAX_FIELD_CHARS))
    : undefined;

  return {
    id: nonEmptyString(card.id) ?? undefined,
    candidateId,
    keyword,
    keyPoints,
    explanation: nonEmptyString(card.explanation)?.slice(0, MAX_FIELD_CHARS),
    sources: extractSources(card.sources),
  };
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ saved: true; file: string } | { skipped: "already-exported" | "user-edited-appended" } | { error: string }>> {
  const limited = enforceRateLimit(request, "vault-export", 30);
  if (limited !== null) return limited;

  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const kind = record.kind;
  const vaultRoot = resolveVaultRoot(typeof record.vaultPath === "string" ? record.vaultPath : undefined);

  try {
    if (kind === "meeting") {
      if (typeof record.snapshot !== "object" || record.snapshot === null) {
        return NextResponse.json({ error: "meeting export requires a snapshot object" }, { status: 400 });
      }
      const args = buildMeetingArgs(record.snapshot as Record<string, unknown>);
      if (args === null) {
        return NextResponse.json({ error: "meeting snapshot requires non-empty id/title and transcriptChunks array" }, { status: 400 });
      }
      args.exportTranscript = extractTranscriptMode(record.exportTranscript);
      if (typeof record.asrModel === "string" && record.asrModel.trim().length > 0) {
        args.asrModel = record.asrModel;
      }
      if (Array.isArray(record.cards) && record.cards.length > 0) {
        args.cards = args.cards ?? [];
        for (const raw of record.cards.slice(0, MAX_CARDS)) {
          if (typeof raw !== "object" || raw === null) continue;
          const cardRecord = raw as Record<string, unknown>;
          const keyword = nonEmptyString(cardRecord.keyword);
          const candidateId = nonEmptyString(cardRecord.candidateId);
          if (keyword === null || candidateId === null) continue;
          if (!args.cards.some((existing) => existing.candidateId === candidateId)) {
            args.cards.push({ keyword, candidateId });
          }
        }
      }
      const asks = buildAskExchanges(record.asks);
      if (asks.length > 0) args.asks = asks;
      const result = exportMeetingToVault(vaultRoot, args);
      if (result.outcome === "skipped") {
        return NextResponse.json({ skipped: result.reason });
      }
      return NextResponse.json({ saved: true, file: result.file });
    }

    if (kind === "concept") {
      if (typeof record.card !== "object" || record.card === null) {
        return NextResponse.json({ error: "concept export requires a card object" }, { status: 400 });
      }
      const card = buildConceptArgs(record.card as Record<string, unknown>);
      if (card === null) {
        return NextResponse.json({ error: "concept card requires non-empty candidateId and keyword" }, { status: 400 });
      }
      // origin_meetings：优先前端传的 sessionId；否则候选账本反查（cardId → sessionId）；
      // 都没有 → candidateId 兜底。
      const explicitSession = nonEmptyString(record.sessionId);
      if (explicitSession !== null) {
        card.originMeeting = explicitSession;
      } else if (card.id) {
        const ledgerEntry = getCandidate(card.id);
        if (ledgerEntry?.sessionId) card.originMeeting = ledgerEntry.sessionId;
      }
      const result = exportConceptToVault(vaultRoot, card);
      if (result.outcome === "skipped") {
        return NextResponse.json({ skipped: result.reason });
      }
      if (result.outcome === "appended") {
        return NextResponse.json({ skipped: "user-edited-appended" });
      }
      return NextResponse.json({ saved: true, file: result.file });
    }

    return NextResponse.json({ error: "kind must be \"meeting\" or \"concept\"" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vault export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
