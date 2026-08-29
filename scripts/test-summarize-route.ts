// Meeting-summary route regression (plan batch 3, B stage, commit 2).
// Verifies the local /api/summarize route appends this session's live-ask Q&A
// history into the provider input context (one-line "问：… 答：…"), with
// truncation protection, without creating new storage. Also unit-tests the
// shared pure helpers in lib/ask-history (extract + one-line serialization).

import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/summarize/route";
import {
  extractAskExchanges,
  formatAskExchangesOneLine,
  MAX_ASK_CONTEXT_CHARS,
  MAX_ASK_FIELD_CHARS,
} from "@/lib/ask-history";
import type { ChatMessage } from "@/types/chat";

const SUMMARIZE_PROMPT_MARKER = "MEETING_SUMMARY_PROMPT_MARKER";
const POLISH_PROMPT_MARKER = "转写文本整理助手";

// --- mock local provider (OpenAI-compatible /v1/chat/completions) ---

const providerBodies: string[] = [];

function startMockProvider(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Connection", "close");
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        providerBodies.push(raw);
        let content = "MEETING-SUMMARY";
        try {
          const parsed = JSON.parse(raw) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const system = parsed.messages?.[0]?.content ?? "";
          if (system.includes(POLISH_PROMPT_MARKER)) {
            content = "polished-transcript";
          }
        } catch {
          // 非法 JSON 时返回默认摘要内容。
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function stopMockServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function summarizeBody(baseUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    earlierTranscript: "会议正在讨论推理优化与 KV cache。",
    summarizationPrompt: SUMMARIZE_PROMPT_MARKER,
    polish: true,
    settings: { llamaCppBaseUrl: baseUrl, llamaCppModel: "qwen3" },
    ...overrides,
  };
}

function bodiesMatching(predicate: (body: string) => boolean): string[] {
  return providerBodies.filter(predicate);
}

function summarizeCallBodies(): string[] {
  return bodiesMatching((body) => body.includes(SUMMARIZE_PROMPT_MARKER));
}

// --- route-level tests ---

async function testSummarizeIncludesAskHistory(baseUrl: string): Promise<void> {
  providerBodies.length = 0;
  const response = await POST(
    makeRequest(
      summarizeBody(baseUrl, {
        askHistory: [
          { question: "KV cache 为什么能加速？", answer: "复用已计算的键值对 [1]。" },
          { question: "有什么前置条件？", answer: "序列长度足够长时收益才明显 [2]。" },
        ],
      }),
    ),
  );

  const payload = (await response.json()) as { summary?: string; error?: string };
  assert.equal(response.status, 200, "总结路由应 200");
  assert.equal(payload.error, undefined);
  assert.equal(payload.summary, "MEETING-SUMMARY");

  const summarizeCalls = summarizeCallBodies();
  assert.equal(summarizeCalls.length, 1, "应仅有一次总结 provider 调用");
  const body = summarizeCalls[0];

  assert.ok(body.includes("<meeting_asks>"), "总结输入应含 <meeting_asks> 块");
  assert.ok(
    body.includes("问：KV cache 为什么能加速？ 答：复用已计算的键值对 [1]。"),
    "应在问/答一行拼接块中携带第一组问答",
  );
  assert.ok(
    body.includes("问：有什么前置条件？ 答：序列长度足够长时收益才明显 [2]。"),
    "应在问/答一行拼接块中携带第二组问答",
  );
}

async function testSummarizeWithoutAskHistoryOmitsBlock(baseUrl: string): Promise<void> {
  providerBodies.length = 0;
  const response = await POST(makeRequest(summarizeBody(baseUrl, { askHistory: [] })));
  const payload = (await response.json()) as { summary?: string };

  assert.equal(response.status, 200);
  assert.equal(payload.summary, "MEETING-SUMMARY");

  const summarizeCalls = summarizeCallBodies();
  assert.equal(summarizeCalls.length, 1);
  assert.ok(
    !summarizeCalls[0].includes("<meeting_asks>"),
    "无询问历史时总结输入不得含 <meeting_asks> 块",
  );
}

// --- unit tests for the shared pure helpers ---

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date(),
    ...extra,
  };
}

function testExtractAskExchangesPairsAndSkipsStreaming(): void {
  const messages: ChatMessage[] = [
    msg("user", "第一个问题"),
    msg("assistant", "第一个答案", { sources: [{ title: "S1", url: "https://s1" }] }),
    msg("user", "第二个问题"),
    msg("assistant", "第二个答案"),
    // 流式未定稿：跳过该 assistant 及其配对 user。
    msg("user", "流式问题"),
    msg("assistant", "流式答案", { isStreaming: true }),
    // 无回答的 user 不产出问答对。
    msg("user", "只有问题"),
  ];

  const exchanges = extractAskExchanges(messages);
  assert.equal(exchanges.length, 2, "应抽取两组完整问答对");
  assert.equal(exchanges[0].question, "第一个问题");
  assert.equal(exchanges[0].answer, "第一个答案");
  assert.deepEqual(exchanges[0].sources, [{ title: "S1", url: "https://s1" }], "会话内存 sources 应透传");
  assert.equal(exchanges[1].question, "第二个问题");
  assert.equal(exchanges[1].answer, "第二个答案");
  assert.equal(exchanges[1].sources, undefined);
}

function testFormatAskExchangesOneLineAndTruncation(): void {
  const long = "字".repeat(MAX_ASK_FIELD_CHARS + 500);
  const exchanges = [
    { question: "Q1", answer: "A1" },
    { question: long, answer: long, sources: [] },
  ];

  const formatted = formatAskExchangesOneLine(exchanges);

  assert.ok(formatted.includes("问：Q1 答：A1"), "首组问答应一行拼接");
  assert.ok(formatted.includes(`问：${"字".repeat(MAX_ASK_FIELD_CHARS)} `), "超长字段应按字段上限截断");
  assert.ok(!formatted.includes("字".repeat(MAX_ASK_FIELD_CHARS + 1)), "不得出现超过字段上限的连续内容");

  // 整行粒度总长截断：大量超长问答不应超过 MAX_ASK_CONTEXT_CHARS（每行整行计入）。
  const many = Array.from({ length: 100 }, (_, i) => ({
    question: `q${i}`,
    answer: "字".repeat(200),
  }));
  const capped = formatAskExchangesOneLine(many, MAX_ASK_CONTEXT_CHARS);
  assert.ok(
    capped.length <= MAX_ASK_CONTEXT_CHARS,
    `总长应≤${MAX_ASK_CONTEXT_CHARS}（实际 ${capped.length}）`,
  );
}

function testExtractAskExchangesSkipsDegraded(): void {
  // 降级/失败回答不得进入总结、vault「会中询问」与训练信号：
  // isDegraded 标志与降级文案前缀（DB 回读无标志场景）两条路径均跳过。
  const messages: ChatMessage[] = [
    msg("user", "降级问题"),
    msg("assistant", "没找到可靠来源，无法给出有依据的回答。\n已尝试：arxiv / hackernews", { isDegraded: true }),
    msg("user", "失败问题"),
    // 无 isDegraded 标志（模拟 DB 回读）→ 前缀匹配兜底
    msg("assistant", "回答生成失败：本地模型生成失败"),
    msg("user", "正常问题"),
    msg("assistant", "正常答案", { sources: [{ title: "S", url: "https://s" }] }),
  ];

  const exchanges = extractAskExchanges(messages);
  assert.equal(exchanges.length, 1, "仅正常问答对入选");
  assert.equal(exchanges[0].question, "正常问题");
  assert.equal(exchanges[0].answer, "正常答案");
}

// --- main ---

async function main(): Promise<void> {
  {
    const { server, baseUrl } = await startMockProvider();
    try {
      await testSummarizeIncludesAskHistory(baseUrl);
    } finally {
      await stopMockServer(server);
    }
    console.log("a) /api/summarize 纳入询问问答对（<meeting_asks> + 问/答一行拼接）通过");
  }

  {
    const { server, baseUrl } = await startMockProvider();
    try {
      await testSummarizeWithoutAskHistoryOmitsBlock(baseUrl);
    } finally {
      await stopMockServer(server);
    }
    console.log("b) /api/summarize 无询问历史时不新增 <meeting_asks> 块 通过");
  }

  testExtractAskExchangesPairsAndSkipsStreaming();
  console.log("c) extractAskExchanges（user→assistant 配对 + 跳过流式 + sources 透传）通过");

  testFormatAskExchangesOneLineAndTruncation();
  console.log("d) formatAskExchangesOneLine（一行拼接 + 字段/总长截断）通过");

  testExtractAskExchangesSkipsDegraded();
  console.log("e) extractAskExchanges 跳过降级/失败回答（标志 + 文案前缀双路径）通过");

  console.log("summarize route regression tests passed");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});