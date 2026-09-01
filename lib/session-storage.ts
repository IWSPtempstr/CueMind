import type { LatencyTrace, SessionSnapshot } from "@/types/session";

const SESSIONS_KEY = "cuemind_sessions_v1";
const MAX_SAVED_SESSIONS = 10;

function reviveLatency(latency: LatencyTrace | undefined): LatencyTrace | undefined {
  if (!latency) return latency;
  return Object.fromEntries(
    Object.entries(latency).map(([key, value]) => [key, value ? new Date(value) : value]),
  ) as LatencyTrace;
}

function revive(session: SessionSnapshot): SessionSnapshot {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    transcriptChunks: session.transcriptChunks.map((chunk) => ({
      ...chunk,
      timestamp: new Date(chunk.timestamp),
      latency: reviveLatency(chunk.latency),
    })),
    suggestionBatches: session.suggestionBatches.map((batch) => ({ ...batch, timestamp: new Date(batch.timestamp) })),
    chatMessages: session.chatMessages.map((message) => ({ ...message, timestamp: new Date(message.timestamp), isStreaming: false })),
    meetingReport: session.meetingReport ? { ...session.meetingReport, generatedAt: new Date(session.meetingReport.generatedAt) } : null,
    postmeetingTranscript: session.postmeetingTranscript
      ? { ...session.postmeetingTranscript, generatedAt: new Date(session.postmeetingTranscript.generatedAt) }
      : undefined,
    contextSummary: session.contextSummary ? { ...session.contextSummary, updatedAt: new Date(session.contextSummary.updatedAt).toISOString() } : undefined,
  };
}

export function loadSessions(): SessionSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as SessionSnapshot[]).map(revive).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch {
    return [];
  }
}

export function storeSession(session: SessionSnapshot): SessionSnapshot[] {
  const sessions = loadSessions().filter((saved) => saved.id !== session.id);
  const next = [session, ...sessions].slice(0, MAX_SAVED_SESSIONS);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(next));
  return next;
}
