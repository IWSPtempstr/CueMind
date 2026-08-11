// Chat UI message model and roles for the meeting copilot thread.

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  isStreaming?: boolean;
  isDetail?: boolean;
  timestamp: Date;
}
