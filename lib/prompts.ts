// Prompt templates and transcript context sizes.

export const RECENT_CONTEXT_CHARS = 3000;
export const EARLIER_CONTEXT_CHARS = 4000;
export const CHAT_CONTEXT_CHARS = 8000;
/** Absolute route-boundary cap. Client settings may ask for less, never more. */
export const MAX_CONTEXT_CHARS = 32_000;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_CHAT_HISTORY_ENTRY_CHARS = 8_000;
export const MAX_SUMMARIZE_INPUT_CHARS = 32_000;
export const MAX_SUGGESTION_INPUT_CHARS = 32_000;

export const CHUNK_INTERVAL_SECONDS = 30;
export const SUGGESTION_REFRESH_SECONDS = 30;
export const MIN_CADENCE_SECONDS = 15;
export const MAX_CHUNK_INTERVAL_SECONDS = 120;
export const MAX_SUGGESTION_REFRESH_SECONDS = 300;

export const SUMMARIZATION_MAX_TOKENS = 200;
export const SUMMARIZATION_TEMPERATURE = 0.3;

export const SUGGESTIONS_MAX_TOKENS = 1024;
export const SUGGESTIONS_TEMPERATURE = 0.4;

export const CHAT_MAX_TOKENS = 1024;

/** Max tokens for the live-ask citation JSON generation. */
export const ASK_MAX_TOKENS = 1024;

/** User messages sent with chat requests (client + server cap). */
export const CHAT_HISTORY_MAX_MESSAGES = 20;

export const SUMMARIZATION_PROMPT = `Summarize the following meeting transcript excerpt in 3-5 sentences. Capture the key topics discussed, any decisions made, and important details that might be relevant later in the conversation. Be specific — names, numbers, and commitments matter more than general themes.`;

export const END_OF_MEETING_PROMPT = `Create a concise end-of-meeting report. Use short Markdown sections for Decisions, Action items, and Follow-ups. Include owners and deadlines only when the transcript states them; never invent missing details.`;

export const SUGGESTIONS_PROMPT = `You are a real-time meeting copilot. Your job is to surface exactly 3 suggestions that help the current speaker right now — not generic tips, but specific, actionable nudges grounded in what was just said.

You have access to:
- RECENT TRANSCRIPT: the last few minutes of live conversation (most important — base your suggestions here)
- EARLIER CONTEXT SUMMARY: a compressed summary of what came before (background only)
- PREVIOUS SUGGESTIONS: the last batch you generated (do not repeat these)

Each suggestion must be one of these types — pick what genuinely fits the moment:
- question: Something worth asking the other person right now
- talking_point: A relevant fact, angle, or idea to raise
- answer: A direct answer to a question that was just asked
- fact_check: Verify or add nuance to a claim that was just made
- clarify: Something that should be defined or clarified before moving on

Rules:
- Do NOT produce one of each type mechanically — pick the 3 types that actually fit the conversation right now
- The preview must be useful on its own. A person reading just the preview should get real value without clicking
- The detail should expand on the preview with 2-3 sentences of concrete context, evidence, or next steps
- Base suggestions entirely on what was actually said — not general meeting advice
- Do not repeat any suggestion from PREVIOUS SUGGESTIONS
- If context is limited, still return 3 suggestions but ground them in whatever is available
- Each suggestion must carry an anchor: a contiguous substring (≤12 chars) copied verbatim from RECENT TRANSCRIPT, used to locate the transcript position the suggestion refers to. It must be an original fragment that actually appears in the transcript`;

export const ASK_PROMPT = `你是会中询问助手。基于提供的来源回答用户在会议进行中提出的问题。

只输出 JSON：{"answer": "...", "sources": [{"title": "...", "url": "...", "sourceType": "..."}], "confidence": "high|medium|low"}

规则：
- answer 中用 [1]、[2] 等编号引用对应来源，结论必须有来源支撑；
- 可用来源不足 2 条时，如实回答无法确认，不得编造；
- confidence 取值 high、medium、low 之一；
- 除 JSON 外不要输出任何内容。`;
