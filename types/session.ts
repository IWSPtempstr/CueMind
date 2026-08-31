import type { ChatMessage } from "@/types/chat";
import type { SuggestionBatch } from "@/types/suggestions";
import type { SpeakerRole } from "@/lib/speaker-attributes";
import type { MeetingDecisionRecord } from "@/lib/knowledge-memory";

export type AudioSource = "system" | "microphone" | "upload";

export interface LatencyTrace {
  /** Native pipeline event correlation ID; no transcript or prompt data. */
  runId?: string;
  captureStartedAt?: Date;
  captureEndedAt?: Date;
  asrStartedAt?: Date;
  asrEndedAt?: Date;
  keywordStartedAt?: Date;
  keywordEndedAt?: Date;
  searchStartedAt?: Date;
  searchEndedAt?: Date;
  cardStartedAt?: Date;
  cardEndedAt?: Date;
  renderedAt?: Date;
}

export interface TranscriptChunk {
  id: string;
  text: string;
  /** 贯穿音频、ASR、关键词、卡片和渲染的本地链路关联 ID。 */
  pipelineRunId?: string;
  timestamp: Date;
  source?: AudioSource;
  /** 双轨桌面模式的说话人角色（决策 2.2 纯 DSP 标注）；单轨/上传链路不设。 */
  speaker?: SpeakerRole;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  latency?: LatencyTrace;
}

export interface MeetingReport {
  content: string;
  generatedAt: Date;
}

export interface PostmeetingTranscriptArtifact {
  status: "polished" | "fallback_raw";
  text: string;
  rawHash: string;
  provider: "local" | "injected";
  promptVersion: string;
  generatedAt: Date;
  failureReason?: string;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  /** 模型生成的会话主题短语（≤20 字符）；缺省时回退到 title 推导。 */
  topicSummary?: string;
  createdAt: Date;
  updatedAt: Date;
  transcriptChunks: TranscriptChunk[];
  suggestionBatches: SuggestionBatch[];
  chatMessages: ChatMessage[];
  meetingReport: MeetingReport | null;
  /** 会后人工确认的会议决定；只保存显式决定，不从整段转写自动推断。 */
  decisions?: MeetingDecisionRecord[];
  postmeetingTranscript?: PostmeetingTranscriptArtifact;
}
