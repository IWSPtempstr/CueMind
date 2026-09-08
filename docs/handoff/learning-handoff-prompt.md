# CueMind 项目学习交接 Prompt

> 在新会话中直接复制下方"交接 Prompt"全文作为第一条消息即可。

## 交接 Prompt

```
我要系统学习 /home/work/asr/CueMind 这个项目（已实现完成，我需要理解它的设计与实现）。
请以教学为导向带我学习，先读 CLAUDE.md → AGENTS.md → README.md 建立项目认知，再按下面的路线推进。

## 项目一句话
CueMind 是一个本地优先的会议实时助手：whisper.cpp 转写会议音频，本地 Qwen3-8B（llama.cpp 双槽）在免打扰前提下持续产出知识卡片（卡片链路），并支持会中即时问答（问答链路）——问答只外发关键词，答案需通过来源和 Schema 校验，无依据时降级拒绝。

## 我的背景与目标
- 我已完成多轮开发迭代，现在目标是吃透架构与关键决策，能在面试中深入讲清每个数字的测量口径
- 学习时请：先讲宏观再钻细节；每个概念关联真实代码位置（文件:行号）；用"为什么这么设计 → 不这么做会怎样"的对比方式

## 学习路线（按序）

### 第一阶段：两条链路的主干
1. 卡片链路：app/api/context-cards/route.ts
   - 关键词提取（750 字符截断 + 1.5s 预算）→ 垂直源短路搜索（arxiv/HN/GitHub/SO 并行 2.5s）→ Tavily 兜底 → 卡片生成（转写 1500 字符 + 来源证据 → keyword/keyPoints(1-4)/whyNow JSON）
   - 关键机制：候选账本（lib/candidate-store.ts，7 种终态记录每次"出卡尝试"）、防重复硬规则、cooldown 节流、ask 让位队列（红线3）
2. 问答链路：app/api/ask/route.ts
   - 意图路由（needsSearch + keywords ≤3 个，1.5s 预算）→ 搜索 → 流式生成（SSE: searching/answer_chunk/done/degraded）
   - 失败语义：InsufficientSearchSourcesError → fail-closed 拒答；提取失败且无 termHint → 基于转写回答或 degraded，绝不外发问题原文（U5 隐私红线）

### 第二阶段：质量与可靠性的三层防线（按实施时间序）
1. GBNF json_schema 约束解码（lib/model-provider.ts postChatCompletions）：4 个 JSON 调用点在采样期强制结构，仅本地 llama.cpp 生效
2. 搜索证据层（lib/search.ts）：Tavily score 低分过滤（<0.2 fail-open）+ include_raw_content 原文 grounding
   - 重要教训：raw 请求给 Tavily 加 0.5~6s 延迟，曾导致 5/80 degraded——修复为"6.5s 预算 + 重试感知（首次带 raw，超时重试无 raw 快速路径）"
3. CiteFix 引用后校验（lib/citation-fix.ts）：按 [n] 切论断、字符二元组覆盖率交叉核对、错配标记重指向；按出现位置逐个判定；fail-open
4. Prompt 工程（lib/prompts.ts ASK_PROMPT）：150 字 + 具体性要求 + sources 非空；旧版通过 hooks/useSettings.ts 迁移自愈

### 第三阶段：评测体系（面试数字的来源）
- 问答：scripts/evaluate-ask-extended.ts（160 题冻结集 fixtures/ask-extended-v2.json）+ scripts/judge-content-quality.ts（本地评审器，cite-matching 只评被引用来源）
- 卡片：scripts/evaluate-cards-video-windows.ts（40 真实窗口切窗）+ scripts/judge-card-quality.ts
- 当前成绩（reports/ 下有全部证据）：
  - 问答：159/160 出答，P50/P95 = 4.3s/7.9s，relevance 3.87 / faithfulness 3.45 / readability 4.85，CiteFix 纠正率 7.5%
  - 卡片：23/40 出卡（其余为 model_skip 免打扰判定），生成 P50 3.9s，relevance 3.96 / faithfulness 3.17 / readability 4.65
- A/B 演进：V1 80字 prompt（rel 3.09/faith 2.40）→ V3 150字（3.52/2.81）→ V4 三防线（3.87/3.45）

### 第四阶段：横切关注点
- 安全：lib/api-security.ts（限流/体积门/输入钳制）、session 鉴权、untrusted 数据隔离（prompt 注入防御）
- 存储：better-sqlite3 + WAL，cuemind_* 存储 key 契约，CUEMIND_DATA_DIR 约定
- 可观测：阶段级 Trace（lib/request-timeline.ts + native-events.jsonl）、JSONL Replay 复现异常
- 密钥隔离：local/session/memory 三档（hooks/useSettings.ts）

## 学习方式
- 每个阶段结束时出 2-3 个"面试官式追问"检验我（如：为什么用 100ms 轮询而不是完成通知？degraded 为什么不算失败？）
- 引导我读真实代码片段而不是转述
- 遇到与我有分歧的地方，以代码和评测报告为准

## 已知边界（避免误导我）
- faithfulness 评审是"标题级启发式"（来源正文不落库），分数有评审器噪声
- 卡片评测的关键词 P95 曾出现 7.4s 伪影：与问答评审并行抢 llama 双槽的排队，非链路退化
- BGE rerank 方案已评估并放弃（Tavily 自带语义排序 + 候选池仅 5 条 + WSL 内存受限）；调研结论在 reports/ 与会话记录中
- 简历口径：问答 P95 ≤8.5s（实测 7.9s）、卡片生成 P50 ≤4s（实测 3.9s）

现在从第一阶段开始，先带我看卡片链路的整体数据流。
```

## 使用说明

1. **配套文件**：交接 prompt 引用的所有路径均为仓库真实文件，新会话可直接读取
2. **学习节奏**：四个阶段约 4-6 次会话；每次会话结束可让 AI 出追问自测
3. **面试准备**：第三阶段的 A/B 演进（3.09→3.52→3.87 的 relevance 爬升）是最能体现工程判断力的素材，重点掌握每一步改了什么、为什么、代价是什么
4. **如需恢复开发上下文**：项目记忆已持久化（存储 key 契约、commit 规范、网络重试等），直接说"继续 CueMind 开发"即可
