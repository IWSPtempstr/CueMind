import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SearchResult } from "@/lib/search";

export type AgentReachSearchErrorCode =
  | "agent_reach_unavailable"
  | "agent_reach_timeout"
  | "agent_reach_invalid_output"
  | "agent_reach_no_usable_sources";

export class AgentReachSearchError extends Error {
  readonly code: AgentReachSearchErrorCode;

  constructor(code: AgentReachSearchErrorCode, message: string) {
    super(message);
    this.name = "AgentReachSearchError";
    this.code = code;
  }
}

type SearchMock = (query: string, timeoutMs: number) => Promise<SearchResult[]>;

declare global {
  var __cuemindAgentReachSearchMock: SearchMock | undefined;
}

const execFileAsync = promisify(execFile);

interface AgentReachDoctorPayload {
  exa_search?: {
    status?: string;
  };
}

export async function searchWithAgentReach(args: {
  query: string;
  timeoutMs: number;
}): Promise<SearchResult[]> {
  const mock = globalThis.__cuemindAgentReachSearchMock;
  if (mock) {
    try {
      return ensureUsableResults(await mock(args.query, args.timeoutMs));
    } catch (error) {
      if (error instanceof AgentReachSearchError) throw error;
      throw new AgentReachSearchError(
        "agent_reach_unavailable",
        "agent-reach search unavailable",
      );
    }
  }

  if (!(await isAgentReachSearchAvailable(args.timeoutMs))) {
    throw new AgentReachSearchError(
      "agent_reach_unavailable",
      "agent-reach search unavailable",
    );
  }

  try {
    const result = await execFileAsync(
      "mcporter",
      [
        "call",
        "exa.web_search_exa",
        `query=${args.query}`,
        "numResults=5",
      ],
      {
        timeout: args.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    return ensureUsableResults(normalizeAgentReachResults(result.stdout));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new AgentReachSearchError(
        "agent_reach_timeout",
        `agent-reach search timed out after ${args.timeoutMs}ms`,
      );
    }
    throw new AgentReachSearchError(
      "agent_reach_unavailable",
      "agent-reach search unavailable",
    );
  }
}

async function isAgentReachSearchAvailable(timeoutMs: number): Promise<boolean> {
  try {
    const doctor = await execFileAsync("agent-reach", ["doctor", "--json"], {
      timeout: Math.min(timeoutMs, 10_000),
      maxBuffer: 1024 * 1024,
    });
    const payload = JSON.parse(doctor.stdout) as AgentReachDoctorPayload;
    return payload.exa_search?.status === "ok";
  } catch {
    return false;
  }
}

function normalizeAgentReachResults(stdout: string): SearchResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new AgentReachSearchError(
      "agent_reach_invalid_output",
      "agent-reach search returned invalid output",
    );
  }

  const candidates = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
      : isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.results)
        ? payload.data.results
        : [];

  return candidates.flatMap((value) => {
    if (!isRecord(value)) return [];
    const title = pickString(value, ["title", "name"]);
    const url = pickString(value, ["url", "link"]);
    const snippet = pickString(value, ["snippet", "text", "content"]);
    if (!title || !url) return [];
    return [{ title, url, snippet: snippet ?? "" }];
  });
}

function ensureUsableResults(results: SearchResult[]): SearchResult[] {
  const usable = results.filter((result) => isHttpUrl(result.url)).slice(0, 5);
  if (usable.length < 2) {
    throw new AgentReachSearchError(
      "agent_reach_no_usable_sources",
      "agent-reach search returned fewer than two usable sources",
    );
  }
  return usable;
}

function pickString(
  value: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key] as string;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isTimeoutError(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    "killed" in value &&
    (value as { killed?: unknown }).killed === true;
}
