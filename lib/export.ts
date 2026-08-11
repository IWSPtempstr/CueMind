import type { SessionSnapshot } from "@/types/session";

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

export function exportSession(session: SessionSnapshot, format: "json" | "md"): void {
  if (format === "json") {
    download(JSON.stringify({ ...session, exportedAt: new Date().toISOString() }, null, 2), "application/json", "json");
    return;
  }

  const lines = [
    `# ${session.title}`,
    "",
    `Exported ${new Date().toLocaleString()}`,
    "",
    "## Transcript",
    "",
    ...session.transcriptChunks.flatMap((chunk) => [
      `**${new Date(chunk.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}** — ${chunk.text}`,
      "",
    ]),
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
  ];
  download(lines.join("\n"), "text/markdown", "md");
}
