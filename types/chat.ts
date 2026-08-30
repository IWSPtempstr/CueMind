// Chat UI message model and roles for the meeting copilot thread.

export type ChatRole = "user" | "assistant";

/** 会中询问的可追溯来源（与卡片来源同构，渲染层共用徽标样式）。 */
export interface AskSource {
  title: string;
  url: string;
  sourceType?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  isStreaming?: boolean;
  isDetail?: boolean;
  /** 询问成功固化时附带的引用来源（仅会话内存，服务端表结构不含该字段）。 */
  sources?: AskSource[];
  /** 询问降级（来源不足）固化的文案标记。 */
  isDegraded?: boolean;
  keywords?: string[];
  finalState?: string;
  timestamp: Date;
}
