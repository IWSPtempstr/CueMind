export interface RedactionManifest {
  ruleVersion: "redaction-v1";
  manualReviewRequired: true;
  replacementCounts: Record<string, number>;
}

export interface RedactionResult {
  text: string;
  manifest: RedactionManifest;
}

export function redactText(input: string, options: { dictionary?: Partial<Record<"PERSON" | "ORG" | "PROJECT", string[]>> } = {}): RedactionResult {
  const counts: Record<string, number> = {};
  const replacements = new Map<string, string>();
  const replace = (value: string, type: string): string => {
    const key = `${type}:${value}`;
    const existing = replacements.get(key);
    if (existing) return existing;
    const next = `[${type}_${(counts[type] ?? 0) + 1}]`;
    counts[type] = (counts[type] ?? 0) + 1;
    replacements.set(key, next);
    return next;
  };
  let text = input;
  for (const [type, values] of Object.entries(options.dictionary ?? {})) {
    for (const value of values ?? []) {
      if (!value.trim()) continue;
      text = text.split(value).join(replace(value, type));
    }
  }
  text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, (value) => replace(value, "EMAIL"));
  text = text.replace(/(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)/g, (value) => replace(value, "PHONE"));
  text = text.replace(/\b(?:sk|api|token|key)[-_A-Za-z0-9]{8,}\b/gi, (value) => replace(value, "SECRET"));
  return { text, manifest: { ruleVersion: "redaction-v1", manualReviewRequired: true, replacementCounts: counts } };
}
