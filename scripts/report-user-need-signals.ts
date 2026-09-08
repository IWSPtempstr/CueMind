// User-need signal report (read-only).
//
// Cross-references the candidate ledger with persisted ask messages to surface
// behavioral quality signals that latency metrics cannot capture:
//   - card_shown but the user still asked about the term  -> card did not explain enough
//   - model_skip but the user later asked about the term  -> model missed a real interest
//   - repeat interest per term within a session           -> unresolved follow-up demand
// Output: markdown report under reports/user-need-signals/ (timestamped, never overwrites).
//
// Usage: npx tsx scripts/report-user-need-signals.ts
// Env:   CUEMIND_DATA_DIR (default <cwd>/.data)

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3") as new (
  path: string,
  options?: { readonly: boolean; fileMustExist: boolean },
) => {
  prepare: (sql: string) => { all: () => unknown[] };
  close: () => void;
};

interface CandidateRow {
  session_id: string;
  candidate_id: string;
  term: string;
  final_state: string;
  suppress_reason: string | null;
  created_at: string;
}

interface AskMessageRow {
  session_id: string;
  role: string;
  keywords_json: string | null;
  final_state: string | null;
  created_at: string;
}

const MIN_TERM_CHARS = 2;

function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Lenient term match mirroring the training export: either side contains the other. */
function termsMatch(candidateTerm: string, askKeyword: string): boolean {
  const term = normalizeTerm(candidateTerm);
  const keyword = normalizeTerm(askKeyword);
  if (term.length < MIN_TERM_CHARS || keyword.length < MIN_TERM_CHARS) return false;
  return term === keyword || term.includes(keyword) || keyword.includes(term);
}

function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

interface TermMatch {
  session_id: string;
  term: string;
  candidateState: string;
  askedAt: string;
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.CUEMIND_DATA_DIR ?? join(process.cwd(), ".data"));
  const dbPath = join(dataDir, "cuemind.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const candidates = db.prepare("SELECT session_id, candidate_id, term, final_state, suppress_reason, created_at FROM candidates").all() as unknown as CandidateRow[];
  const askRows = db.prepare("SELECT session_id, role, keywords_json, final_state, created_at FROM chat_messages ORDER BY created_at ASC, rowid ASC").all() as unknown as AskMessageRow[];
  db.close();

  const askTurns = askRows
    .filter((row) => row.role === "assistant")
    .map((row) => ({ sessionId: row.session_id, keywords: parseKeywords(row.keywords_json).map(normalizeTerm), createdAt: row.created_at }));

  const matchesLaterAsk = (candidate: CandidateRow, stateFilter: string): TermMatch[] => {
    if (candidate.final_state !== stateFilter) return [];
    const term = normalizeTerm(candidate.term);
    if (term.length < MIN_TERM_CHARS) return [];
    return askTurns
      .filter((turn) => turn.sessionId === candidate.session_id && turn.createdAt >= candidate.created_at)
      .filter((turn) => turn.keywords.some((keyword) => termsMatch(candidate.term, keyword)))
      .map((turn) => ({ session_id: candidate.session_id, term: candidate.term, candidateState: stateFilter, askedAt: turn.createdAt }));
  };

  const cardShownThenAsked = candidates.flatMap((candidate) => matchesLaterAsk(candidate, "card_shown"));
  const skippedThenAsked = candidates.flatMap((candidate) => matchesLaterAsk(candidate, "model_skip"));

  const terminalStates: Record<string, number> = {};
  for (const candidate of candidates) terminalStates[candidate.final_state] = (terminalStates[candidate.final_state] ?? 0) + 1;

  // Repeat interest: same term asked more than once within a session.
  const termAskCounts = new Map<string, number>();
  for (const turn of askTurns) {
    for (const keyword of new Set(turn.keywords)) {
      const key = `${turn.sessionId}::${keyword}`;
      termAskCounts.set(key, (termAskCounts.get(key) ?? 0) + 1);
    }
  }
  const repeatedTerms = [...termAskCounts.entries()].filter(([, count]) => count >= 2);

  const lines: string[] = [
    "# User-Need Signal Report",
    "",
    `- Generated at: ${new Date().toISOString()}`,
    `- Data dir: ${dataDir} (read-only)`,
    `- Candidates analyzed: ${candidates.length}`,
    `- Ask turns (assistant messages) analyzed: ${askTurns.length}`,
    "",
    "## 1. Candidate terminal-state distribution",
    "",
    "| Final state | Count |",
    "|---|---|",
    ...Object.entries(terminalStates).sort((a, b) => b[1] - a[1]).map(([state, count]) => `| ${state} | ${count} |`) as string[],
    "",
    "## 2. Card shown, user still asked (card did not explain enough)",
    "",
    ...(cardShownThenAsked.length === 0
      ? ["_No matches._"]
      : ["| Session | Term | Asked at |", "|---|---|---|", ...cardShownThenAsked.map((m) => `| ${m.session_id} | ${m.term} | ${m.askedAt} |`)] as string[]),
    "",
    "## 3. Model skipped, user later asked (missed interest)",
    "",
    ...(skippedThenAsked.length === 0
      ? ["_No matches._"]
      : ["| Session | Term | Asked at |", "|---|---|---|", ...skippedThenAsked.map((m) => `| ${m.session_id} | ${m.term} | ${m.askedAt} |`)] as string[]),
    "",
    "## 4. Repeat interest within a session (term asked >= 2 times)",
    "",
    ...(repeatedTerms.length === 0
      ? ["_No repeats._"]
      : ["| Session | Keyword | Ask count |", "|---|---|---|", ...repeatedTerms.sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, count]) => { const [sessionId, keyword] = key.split("::"); return `| ${sessionId} | ${keyword} | ${count} |`; })] as string[]),
    "",
    "## Interpretation",
    "",
    "- Section 2 rows are direct \"card quality insufficient\" signals feeding the DPO training loop.",
    "- Section 3 rows are \"model missed a real interest\" signals; confirmed entries should become candidates (U3 entry point).",
    "- Section 4 shows unresolved demand even when cards/answers existed.",
    "- Latency/terminal-state metrics say nothing about these; they only appear when the ledger is cross-referenced with asks.",
    "",
  ];

  const outputDir = resolve("reports/user-need-signals");
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, `report-${Date.now()}.md`);
  await writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`user-need signal report written: ${outPath}`);
  console.log(`card_shown+asked=${cardShownThenAsked.length} model_skip+asked=${skippedThenAsked.length} repeated_terms=${repeatedTerms.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
