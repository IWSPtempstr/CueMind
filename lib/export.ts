import type { SessionSnapshot } from "@/types/session";
import { redactText } from "@/lib/redaction";
import { buildTimeline } from "@/lib/timeline";

function download(content: string, type: string, extension: "json" | "md"): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cuemind-session-${new Date().toISOString().split("T")[0]}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface ExportSessionOptions {
  transcript?: "raw" | "polished";
  redacted?: boolean;
  redactionDictionary?: Partial<Record<"PERSON" | "ORG" | "PROJECT", string[]>>;
}

export function exportSession(session: SessionSnapshot, format: "json" | "md", options: ExportSessionOptions = {}): void {
  const transcriptText = options.transcript === "polished" && session.postmeetingTranscript?.text
    ? session.postmeetingTranscript.text
    : session.transcriptChunks.map((chunk) => chunk.text).join("\n");
  const redacted = options.redacted ? redactText(transcriptText, { dictionary: options.redactionDictionary }) : null;
  const outputTranscript = redacted?.text ?? transcriptText;
  const timeline = buildTimeline({
    transcriptChunks: session.transcriptChunks,
  });
  if (format === "json") {
    const payload = { ...session, exportedAt: new Date().toISOString(), exportedTranscript: outputTranscript, timeline, ...(redacted ? { redactionManifest: redacted.manifest } : {}) };
    download(JSON.stringify(payload, null, 2), "application/json", "json");
    return;
  }

  const lines = [
    `# ${session.title}`,
    "",
    `Exported ${new Date().toLocaleString()}`,
    "",
    "## Transcript",
    "",
    ...(options.transcript === "polished" || options.redacted
      ? [outputTranscript, ""]
      : session.transcriptChunks.flatMap((chunk) => [`<a id="transcript-${chunk.id}"></a>**${new Date(chunk.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}** — ${chunk.text}`, ""])),
    "## Suggestions",
    "",
    ...session.suggestionBatches.flatMap((batch) => [
      `### ${new Date(batch.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      "",
      ...batch.suggestions.flatMap((suggestion) => [`- **${suggestion.type.replaceAll("_", " ")}**: ${suggestion.preview}`, `  ${suggestion.detail}`, ""]),
    ]),
    "## Chat",
    "",
    ...session.chatMessages.filter((message) => !message.isDetail).flatMap((message) => [
      `**${message.role === "user" ? "You" : "CueMind"} · ${new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}**`,
      "",
      message.content,
      "",
    ]),
    ...(session.meetingReport ? ["## Meeting report", "", session.meetingReport.content, ""] : []),
    "## Timeline",
    "",
    "See the accompanying timeline data in JSON export for stable millisecond locations.",
  ];
  if (redacted) lines.push("", `Redaction rule: ${redacted.manifest.ruleVersion}; manual review required: yes.`);
  download(lines.join("\n"), "text/markdown", "md");
}
