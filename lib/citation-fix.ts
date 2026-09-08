// CiteFix-style post-hoc citation verification (heuristic, no model call):
// split the validated answer into factual points by [n] markers, score each
// point against the retrieved search sources via character-bigram coverage,
// and reassign markers whose point text clearly matches a different source
// better than the cited one (ACL 2025 industry track: CiteFix reports +15%
// citation accuracy with negligible latency from the same idea).
//
// Fail-open by design: any doubt (short points, weak overlap, close scores)
// keeps the original citation; markers are never dropped, only repointed.

import type { SearchResult } from "@/lib/search";

export interface CitationFixSource {
  title: string;
  url: string;
  sourceType?: string;
}

export interface CitationFixOutcome {
  answer: string;
  sources: CitationFixSource[];
  /** Marker occurrences repointed to a different source (observability). */
  corrections: number;
}

// A point shorter than this carries no usable lexical signal.
const MIN_POINT_CHARS = 6;
// Best-source coverage floor: below this the point matches nothing well.
const MIN_COVERAGE = 0.15;
// Reassignment margin: best must beat the cited source by this factor.
const REASSIGN_RATIO = 1.5;
// Raw content considered when scoring a point against a source.
const SCORE_CONTENT_CHARS = 1_500;

type Part = { kind: "text"; value: string } | { kind: "marker"; value: number };

export function fixCitations(
  answer: string,
  searchSources: SearchResult[],
): CitationFixOutcome {
  const promptSources = searchSources.slice(0, 5);
  if (promptSources.length === 0) return { answer, sources: [], corrections: 0 };

  const parts = splitAnswer(answer);
  if (!parts.some((part) => part.kind === "marker")) {
    return { answer, sources: [], corrections: 0 };
  }

  // Per-occurrence decision: each [n] is judged against the factual point
  // text that precedes it (text since the previous marker). The same marker
  // value appearing on two different points can legitimately be repointed
  // to two different sources — that is exactly the miscite CiteFix fixes.
  const occurrenceTargets: Array<number | null> = [];
  let pointText = "";
  for (const part of parts) {
    if (part.kind === "text") {
      pointText += part.value;
      continue;
    }
    const citedIndex = part.value - 1;
    occurrenceTargets.push(
      part.value >= 1 && part.value <= promptSources.length
        ? resolveSourceIndex(pointText, citedIndex, promptSources)
        : null,
    );
    pointText = "";
  }

  // Rebuild the sources array in first-appearance order of the mapped
  // sources, then renumber every marker occurrence to its new position.
  const orderedIndices: number[] = [];
  for (const target of occurrenceTargets) {
    if (target === null || orderedIndices.includes(target)) continue;
    orderedIndices.push(target);
  }
  const sources: CitationFixSource[] = orderedIndices.map((index) =>
    toFixSource(promptSources[index]),
  );

  let corrections = 0;
  let occurrence = 0;
  const rebuilt = parts
    .map((part) => {
      if (part.kind === "text") return part.value;
      const target = occurrenceTargets[occurrence];
      occurrence += 1;
      if (target === null) return `[${part.value}]`;
      const position = orderedIndices.indexOf(target);
      if (position < 0) return `[${part.value}]`;
      if (target !== part.value - 1) corrections += 1;
      return `[${position + 1}]`;
    })
    .join("");

  return { answer: rebuilt, sources, corrections };
}

function resolveSourceIndex(
  pointText: string,
  citedIndex: number,
  promptSources: SearchResult[],
): number {
  const trimmed = pointText.replace(/\s+/g, "").trim();
  if (trimmed.length < MIN_POINT_CHARS) return citedIndex;
  const pointGrams = bigrams(trimmed);
  if (pointGrams.size === 0) return citedIndex;

  let bestIndex = citedIndex;
  let bestCoverage = -1;
  let citedCoverage = -1;
  promptSources.forEach((source, index) => {
    const coverage = coverageOf(pointGrams, sourceText(source));
    if (index === citedIndex) citedCoverage = coverage;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestIndex = index;
    }
  });
  if (
    bestIndex === citedIndex ||
    bestCoverage < MIN_COVERAGE ||
    bestCoverage < citedCoverage * REASSIGN_RATIO
  ) {
    return citedIndex;
  }
  return bestIndex;
}

function sourceText(source: SearchResult): string {
  const content = typeof source.content === "string" ? source.content.slice(0, SCORE_CONTENT_CHARS) : "";
  return `${source.title} ${source.snippet} ${content}`;
}

function toFixSource(source: SearchResult): CitationFixSource {
  return source.sourceType === undefined
    ? { title: source.title, url: source.url }
    : { title: source.title, url: source.url, sourceType: source.sourceType };
}

function splitAnswer(answer: string): Part[] {
  const parts: Part[] = [];
  let lastIndex = 0;
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ kind: "text", value: answer.slice(lastIndex, index) });
    parts.push({ kind: "marker", value: Number(match[1]) });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < answer.length) parts.push({ kind: "text", value: answer.slice(lastIndex) });
  return parts;
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

function coverageOf(pointGrams: Set<string>, sourceText: string): number {
  if (pointGrams.size === 0) return 0;
  let hits = 0;
  for (const gram of pointGrams) {
    if (sourceText.includes(gram)) hits += 1;
  }
  return hits / pointGrams.size;
}
