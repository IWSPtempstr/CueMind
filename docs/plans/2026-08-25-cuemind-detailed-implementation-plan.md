# CueMind 详细实施计划

> 版本：v1.0  
> 日期：2026-08-25  
> 目标：形成一个可实时演示、可量化评估、能写进简历并能在面试中讲清楚的本地优先会议认知助手。

## 1. 项目摘要

CueMind 面向中文为主、允许中英混合术语的 AI/软件工程技术会议。它不替用户完成完整会议总结，而是在讨论窗口仍然有效时，从最近 30～60 秒的转写中识别少量重要或陌生的技术术语，通过联网搜索补充背景，生成一张几秒内可读完的中文上下文卡片。

核心链路：

```text
本地文件回放 / 麦克风
        -> 本地 ASR
        -> 30-60 秒转写窗口
        -> Agent 识别术语并决定是否值得展示
        -> 最多两次搜索工具调用
        -> 本地模型生成卡片
        -> 本地失败时透明地远程兜底
        -> 会后人工确认
        -> 有用卡片进入个人主题知识库
```

第一阶段的产品价值不是“解释最深”，而是“来得及”。系统需要在用户仍在听当前话题时，用低负担信息补齐上下文。

## 2. 已锁定的产品决策

### 2.1 目标用户和场景

- 目标场景：AI、LLM、Agent、数据库、部署、系统架构和软件工程会议。
- 语言：中文会议为主，保留英文术语、缩写和专有名词。
- 运行形式：Windows 桌面端；支持本地文件实时回放和麦克风实时输入。
- 卡片密度：宁少勿错；10 分钟约 3～5 张卡片。
- 主要验收：一段约 10 分钟技术视频能端到端产生 3～5 张有用卡片。

### 2.2 卡片形态

实时卡片默认只显示：

1. 术语。
2. 一句话中文解释。
3. 为什么现在出现。
4. 一个来源标题和链接。

检索到多个来源时，默认显示一个，用户可以展开查看其余来源。卡片还要显示生成方和状态，例如“本地模型生成”“远程模型生成”“未联网验证”。

卡片不是长文章，不默认展示完整搜索摘要、全部证据和复杂评分。原始转写、查询词、完整来源、重试轨迹和延迟进入复盘/调试视图。

### 2.3 反馈和知识库

- 会议中自动推送卡片。
- 用户可以在会后复盘页逐张标记“有用”或“无关”。
- 只有会后标记为“有用”的卡片才进入个人知识库。
- 用户反馈形成跨会议的长期偏好，用于降低熟悉词和无关词的触发概率。
- 知识库按固定工程主题自动分类，同时允许用户创建自定义主题。
- 后续会议先查个人知识库，再根据上下文、时间或用户操作联网更新。

### 2.4 隐私和远程兜底

- 默认本地 ASR、本地模型、本地会话和本地知识库。
- 本地模型也可以通过搜索工具访问公开网络。
- 本地模型或 ASR 失败时自动调用远程服务，但界面必须明显标记。
- 远程兜底只发送最小必要上下文：术语、相关短转写片段、搜索结果和输出 Schema。
- 不发送完整会议记录。
- 无来源的远程解释必须标记“未联网验证”，且不自动进入知识库。

## 3. 目标架构

### 3.1 模块边界

| 模块 | 职责 | 第一阶段实现 |
| --- | --- | --- |
| 音频输入 | 文件回放、麦克风采集、统一时间轴 | 保留两种输入，统一事件格式 |
| 本地 ASR | 音频转写、时间戳、错误记录 | 本地优先；保留远程可选适配器 |
| Transcript window | 维护最近 30～60 秒可见文本 | 按时间和片段 ID 可重放 |
| Trigger Agent | 识别术语、判断重要性、决定是否展示、生成查询词 | 本地 Qwen3-4B/llama.cpp |
| Search tool | 受控技术来源搜索 | 最多两次调用，超时可终止 |
| Card generator | 根据术语、上下文和来源生成中文卡片 | 本地优先，远程透明兜底 |
| Feedback | 会后“有用/无关/不再提示” | 本地持久化 |
| Knowledge base | 主题归档和后续复用 | 只接收用户确认过的卡片 |
| Telemetry | 记录 trace、延迟、错误、provider 和成本 | JSONL/本地报告 |
| Replay | 用固定事件重放端到端流程 | 第一阶段必须可用 |

### 3.2 建议代码边界

现有相关代码优先复用：

- `app/api/context-cards/route.ts`：改造成结构化 Agent 编排入口。
- `lib/ollama.ts`：本地模型调用和结构化输出验证。
- `lib/search.ts`：搜索工具、来源过滤、超时和重试。
- `lib/telemetry.ts`：统一阶段延迟和运行元数据。
- `lib/replay.ts`：固定事件回放。
- `hooks/useContextCards.ts`：自动触发和卡片状态。
- `components/LatencyPanel.tsx`：可视化阶段延迟和 provider 切换。

桌面端和本地音频相关代码继续沿用：

- `desktop/electron/main.ts`
- `desktop/electron/preload.ts`
- `native/CueMind.Audio/AudioCaptureService.cs`
- `native/CueMind.Audio/JsonlEventWriter.cs`
- `hooks/useDesktopTranscript.ts`

如果当前实现和旧计划中的字段或行为不一致，以当前源码、`PRODUCT.md`、`DESIGN.md` 和本计划的明确决策为准；旧计划中未验证的目标不能当作已实现事实。

## 4. 统一事件和输出契约

### 4.1 转写事件

每个 ASR 片段至少包含：

```json
{
  "eventType": "transcript.final",
  "sessionId": "session-001",
  "chunkId": "chunk-001",
  "source": "microphone",
  "startMs": 12000,
  "endMs": 18500,
  "text": "我们现在要看一下 KV Cache 对推理吞吐的影响",
  "asrProvider": "local-whisper",
  "capturedAt": "2026-08-25T10:00:12.000Z"
}
```

### 4.2 Agent 运行轨迹

每次术语候选处理必须产生可审计 trace：

```json
{
  "traceId": "trace-001",
  "sessionId": "session-001",
  "task": "context_card",
  "inputChunkIds": ["chunk-001"],
  "modelProvider": "local",
  "modelName": "qwen3-4b-instruct-2507-q4_k_m",
  "events": [
    {
      "step": 1,
      "type": "model_decision",
      "decision": "search",
      "term": "KV Cache",
      "shouldSurface": true
    },
    {
      "step": 2,
      "type": "tool_call",
      "tool": "search_web",
      "query": "KV Cache LLM inference throughput explanation",
      "sourceFilters": ["official", "github", "arxiv"],
      "durationMs": 920
    },
    {
      "step": 3,
      "type": "tool_result",
      "resultCount": 4,
      "trustedResultCount": 2
    },
    {
      "step": 4,
      "type": "card_generation",
      "provider": "local",
      "durationMs": 1100
    }
  ],
  "finalState": "card_generated",
  "totalLatencyMs": 6100
}
```

### 4.3 卡片输出

```json
{
  "keyword": "KV Cache",
  "explanation": "KV Cache 会缓存已计算的键和值，减少生成后续 token 时的重复计算。",
  "whyNow": "当前讨论正在分析本地 LLM 推理吞吐，KV Cache 是影响生成速度和显存占用的关键机制。",
  "source": {
    "title": "Attention Is All You Need / official technical explanation",
    "url": "https://example.com/source",
    "type": "official"
  },
  "verified": true,
  "generatedBy": "local",
  "transcriptChunkIds": ["chunk-001"]
}
```

## 5. 数据集和标注计划

### 5.1 会议语境数据

分三层使用：

| 数据来源 | 作用 | 处理方式 |
| --- | --- | --- |
| QMSum、VCSum | 快速建立会议窗口 baseline | 切成 30～60 秒窗口，利用主题/摘要辅助候选发现 |
| AMI、ICSI | 验证多人会议、说话人切换和口语上下文 | 保留时间戳和说话人信息，按完整会议拆分 |
| 公开中文 AI/工程视频 | 验证中文 ASR、英文术语和真实技术内容 | 本地 ASR，保留真实识别错误，按视频拆分 |

公开视频不作为通用会议数据的等价替代。它主要用于补充术语密度和中文 ASR 场景，报告中要明确“会议数据”和“技术分享数据”的分布差异。

### 5.2 术语素材

| 数据来源 | 提供能力 | 不可直接推导的标签 |
| --- | --- | --- |
| KP20k、Inspec、SemEval | 关键词/短语边界 | 是否现在值得打断用户 |
| SciERC、arXiv 术语数据 | 科学技术实体结构 | 用户是否陌生 |
| Stack Overflow、GitHub README/Issue | 软件工程术语和缩写 | 卡片是否对本次会议有用 |

这些数据用于术语候选训练或提示词评估，不直接充当 CueMind 的产品真值。

### 5.3 CueMind 专属标签

每个候选样本至少标注：

- `term`：术语规范名。
- `span`：转写中的原始片段。
- `termType`：技术概念、模型、框架、协议、数据库、部署组件等。
- `importance`：high、medium、low。
- `noveltyLikely`：对一般工程用户是否可能陌生的代理标签。
- `shouldSurface`：此时是否值得弹卡。
- `reason`：主题中心、决策相关、技术具体、重复出现、泛化词、偶然提及等。
- `query`：推荐搜索查询词。
- `cardCorrect`：解释是否基本正确。
- `usefulAfterMeeting`：是否帮助用户跟上当前讨论。

强模型只生成预标注，人工审核最终标签。冻结测试集中的关键标签不得只由同一个模型生成。

### 5.4 首版规模和拆分

- 10～15 段公开技术视频或会议材料。
- 每段 5～10 分钟。
- 约 100～150 个 30～60 秒窗口。
- 人工重点审核 30～50 个候选样本。
- 开发集和冻结测试集按完整视频拆分，不按随机窗口拆分。
- 测试集中的原文、来源 URL 和相邻窗口不得出现在开发数据中。
- 第一阶段先做开发集 + 冻结测试集，不立即构造大规模训练集。

## 6. Agent 评估总原则

Agent 不只评最终卡片，还要评估：

```text
是否选对任务
→ 是否选择正确工具
→ 参数是否有效
→ 是否搜索过多
→ 是否正确理解工具结果
→ 是否遵守来源和隐私约束
→ 是否在预算内结束
→ 最终卡片是否相关、正确、有用
```

传统的字符串相等测试不足以覆盖这条链路。Agent 的失败可能是最终答对但绕路、调用了错误工具、重复搜索、被来源内容注入，或在超时后没有停止。因此必须同时保留结果评估和轨迹评估。

## 7. Agent 评估指标

### 7.1 指标分层

| 层级 | 评估对象 | 主要方法 |
| --- | --- | --- |
| 协议层 | JSON Schema、事件字段、trace 完整性 | 程序化断言，硬失败 |
| 工具层 | 工具选择、参数、调用次数、结果解析 | 规则校验 + gold action |
| 轨迹层 | 顺序、重复、绕路、停止条件、隐私边界 | trace evaluator |
| 任务层 | 是否找出值得弹卡的术语、是否生成正确卡片 | 人工标签 + 规则 + judge |
| 系统层 | 端到端成功、延迟、资源、故障恢复 | replay、压测、故障注入 |
| 线上层 | 用户有用率、反馈、漂移、兜底比例 | 本地 telemetry 和反馈聚合 |

### 7.2 工具调用正确性

| 指标 | 定义 | 首版目标 | 发布候选门槛 |
| --- | --- | ---: | ---: |
| Tool-call schema validity | 工具名和参数符合 Schema 的调用 / 全部调用 | >= 98% | >= 99% |
| Tool selection precision | 应搜索样本中选择 `search_web` 的比例 | >= 90% | >= 95% |
| Unnecessary tool-call rate | 不应搜索却发起搜索的比例 | <= 15% | <= 10% |
| Invalid query rate | 空查询、泛化查询、包含无关整段转写的比例 | <= 10% | <= 5% |
| Query usefulness | 查询返回至少一个相关技术来源的比例 | >= 70% | >= 85% |
| Search call cap compliance | 未超过每候选 2 次搜索的任务比例 | 100% | 100% |
| Source filter compliance | 遵守受控来源优先策略的比例 | >= 90% | >= 95% |

### 7.3 轨迹和 Agent 行为

| 指标 | 定义 | 首版目标 | 发布候选门槛 |
| --- | --- | ---: | ---: |
| Valid trajectory rate | 从决策到结束的 trace 字段完整且顺序合法 | >= 98% | >= 99% |
| Correct terminal state | 应生成、应跳过、搜索失败或兜底状态与标签一致 | >= 85% | >= 90% |
| Minimal-path rate | 在允许路径内完成且没有多余步骤的比例 | >= 80% | >= 90% |
| Duplicate-call rate | 相同术语的重复查询或重复卡片比例 | <= 10% | <= 5% |
| Max-step compliance | 未超过模型决策 + 两次搜索 + 生成的硬上限 | 100% | 100% |
| Stop-on-timeout rate | 工具或模型超时后能终止并记录状态的比例 | >= 98% | 100% |
| Trace completeness | 每次运行均记录输入、工具、结果、provider、耗时和终态 | >= 98% | 100% |

### 7.4 端到端任务成功

定义一条样本成功必须同时满足：

- 对 `shouldSurface=true` 的样本，识别出正确术语或可接受别名；
- 生成卡片或按策略进入明确的可解释兜底；
- 卡片与当前窗口相关；
- 卡片基本事实正确；
- 来源和生成方状态正确；
- 总延迟未超出该样本预算。

指标：

| 指标 | 定义 | 首版目标 | 发布候选门槛 |
| --- | --- | ---: | ---: |
| Trigger precision | 触发卡片且人工标签应触发的比例 | >= 70% | >= 80% |
| Trigger recall | 应触发样本中实际触发的比例 | >= 60% | >= 70% |
| No-card precision | 正确跳过样本 / 所有跳过样本 | >= 80% | >= 90% |
| Card factual correctness | 人工审核事实基本正确的卡片比例 | >= 85% | >= 92% |
| Context relevance | 能解释“为什么现在出现”的卡片比例 | >= 75% | >= 85% |
| Useful-card rate | 会后标记有用的卡片 / 被审核卡片 | >= 50% | >= 65% |
| End-to-end success | 满足上述成功条件的任务比例 | >= 60% | >= 75% |

首版目标是开发方向，不代表当前实现已经达到。所有结果必须报告分母、失败数、跳过数、阻塞数和未验证的外部依赖。

### 7.5 Pass^k 稳定性

由于本地模型和远程模型具有非确定性，同一输入至少重复运行 3 次：

```text
Pass^3 = 三次运行均满足工具约束、终态正确且卡片不违反事实/来源规则的样本数
         / 重复运行样本总数
```

建议分开报告：

- `ToolSafety-Pass^3`：三次都没有非法调用、超限调用或隐私越界。
- `Decision-Pass^3`：三次都正确决定展示或跳过。
- `CardQuality-Pass^3`：三次卡片都达到最低相关性和事实正确性。
- `E2E-Pass^3`：三项同时通过。

首版目标：

- `ToolSafety-Pass^3 >= 95%`。
- `Decision-Pass^3 >= 65%`。
- `E2E-Pass^3 >= 50%`。

发布候选目标：

- `ToolSafety-Pass^3 = 100%`。
- `Decision-Pass^3 >= 75%`。
- `E2E-Pass^3 >= 65%`。

### 7.6 效率和成本

| 指标 | 定义 | 门槛 |
| --- | --- | ---: |
| Tool calls per candidate | 每个候选术语的搜索调用数 | <= 2，硬上限 |
| Model steps per task | 决策、工具、观察、生成的总步骤 | <= 5 |
| Unproductive-step rate | 未改变任务状态的步骤比例 | <= 10% |
| Local token usage | 本地模型输入/输出 token | 按硬件基线记录，不伪造成本 |
| Remote fallback rate | 远程兜底任务 / 总任务 | 首版 <= 30%，发布 <= 20% |
| Search-result utilization | 被卡片引用或实际影响生成的结果 / 返回结果 | >= 50% |
| Card throughput | 10 分钟会议有效卡片数量 | 3～5 张 |

“调用次数少”不等于效率好；必须同时检查任务成功率。一个少调用但经常漏卡的 Agent 不能判定为高效。

### 7.7 延迟和资源

| 指标 | 目标 |
| --- | ---: |
| ASR chunk latency P50 | 记录基线，按本机实测 |
| Keyword decision P50 | <= 2.5s |
| Search stage P50 | <= 2.5s |
| Card total latency P50 | <= 8s |
| Card total latency P95 | <= 15s |
| Timeout terminal state | 100% 有限时间内结束 |
| End-to-end hard timeout | <= 30s |
| Memory/VRAM | 记录峰值，不能只报告模型文件大小 |

本地 mock 或 replay 的延迟只能作为开发基线。发布前必须单独报告真实本地模型、真实 ASR、真实搜索和远程兜底的 P50/P95。

### 7.8 安全、来源和提示注入

建立至少 20 条红队样本，覆盖：

- 搜索结果页面包含“忽略系统提示”的指令；
- 术语文本包含恶意工具参数；
- 网页内容要求泄露完整会议转写；
- 网页内容诱导调用第二个未授权工具；
- 用户标记无用后仍要求强制保存知识库；
- 远程兜底上下文意外包含完整会议记录。

指标：

| 指标 | 定义 | 发布门槛 |
| --- | --- | ---: |
| Prompt-injection resistance | 红队样本未执行来源中的恶意指令 | 100% |
| Data-boundary compliance | 远程请求只包含最小必要上下文 | 100% |
| Unauthorized-tool rate | 未注册工具被调用的比例 | 0% |
| Knowledge-base consent compliance | 未被用户标记有用的卡片进入知识库比例 | 0% |
| Source traceability | 卡片来源可回溯到 URL 和搜索结果 | >= 98% |
| Unverified labeling | 无来源卡片正确标记未验证 | 100% |

网页来源是数据，不是指令。搜索结果只能作为证据输入，不能改变 Agent 的系统规则、工具权限或隐私边界。

### 7.9 Judge 评估治理

LLM-as-a-judge 只用于开放式的相关性、简洁性和解释质量，不用于替代可程序化的工具调用和 Schema 校验。

要求：

- 固定 judge 模型、版本、temperature 和 rubric；
- rubric 逐档定义 1～5 分含义并提供正反例；
- 20% 样本由人工复核 judge 结果；
- 至少报告 judge 与人工的一致率或 Cohen's kappa；
- 比较模型时随机交换 A/B 顺序，检查首位偏差；
- 不把更长回答自动判为更好，单独检查卡片长度；
- 不让被评模型担任自己的唯一 judge；
- 评估报告保留 judge prompt、输出和版本。

推荐卡片 judge 维度：

| 维度 | 评分问题 |
| --- | --- |
| Relevance | 是否和当前会议窗口直接相关 |
| Factuality | 是否有明显事实错误或无依据扩展 |
| Timeliness | 是否解释了为什么现在需要它 |
| Concision | 是否能在几秒内读完 |
| Actionability | 是否能帮助用户继续跟上讨论 |

## 8. 评估数据和报告产物

每次评估生成：

1. `manifest.json`：代码版本、模型、量化、硬件、数据集版本、搜索配置、时间和随机种子。
2. `scorecard.json`：各指标分数、分母、阈值、是否通过。
3. `traces.jsonl`：逐任务 Agent 轨迹。
4. `outputs.jsonl`：逐任务模型输出和卡片。
5. `errors.jsonl`：机器可读错误标签。
6. `latency.jsonl`：每阶段延迟和 provider。
7. `report.md`：人类可读总结、失败案例和证据边界。

错误标签至少包括：

- `wrong_term`
- `missed_surface_candidate`
- `false_surface`
- `duplicate_term`
- `invalid_tool_args`
- `wrong_tool`
- `too_many_tool_calls`
- `empty_search`
- `untrusted_source`
- `source_not_supporting_claim`
- `invalid_card_schema`
- `unsupported_claim`
- `timeout_without_terminal_state`
- `fallback_without_label`
- `privacy_boundary_violation`
- `prompt_injection_followed`
- `knowledge_saved_without_consent`

## 9. 实施阶段

### 阶段 0：基线和契约

目标：在不改产品行为的情况下确认当前基线。

工作：

- 固定当前分支、Node、模型和搜索配置。
- 运行 TypeScript、lint、build 和现有评估脚本。
- 对照 `docs/evaluation/context-card-eval-contract.md` 补充 Agent trace 字段。
- 定义事件 ID、模型版本和运行 manifest。

完成标准：任何一次评估都能定位到代码版本、模型版本、数据版本和失败样本。

### 阶段 1：端到端演示闭环

目标：先让完整链路可用。

工作顺序：

1. 统一文件回放和麦克风输入事件。
2. 接通本地 ASR 和时间戳转写。
3. 接通本地 Qwen3-4B/llama.cpp。
4. 实现结构化术语候选输出。
5. 实现 Agent 搜索工具和两次调用上限。
6. 实现来源过滤、超时和搜索失败状态。
7. 实现本地卡片生成和 Schema 校验。
8. 加入远程透明兜底。
9. 接通实时卡片 UI、来源展开和延迟面板。
10. 接通会后复盘页和有用卡片保存。

完成标准：本地文件回放能产生可追踪的 3～5 张卡片；麦克风模式能消费同一套事件；失败不会无限等待。

### 阶段 2：数据和 replay 评估

目标：用固定输入复现行为，而不是只展示一次成功 Demo。

工作：

- 收集并登记 QMSum/VCSum/AMI/ICSI 和公开中文技术视频来源。
- 对中文视频执行真实本地 ASR。
- 切分 30～60 秒窗口。
- 强模型预标注，人工审核关键样本。
- 按完整视频拆分开发集和冻结测试集。
- 建立 JSONL replay，固定事件时间和输入。
- 运行 3 次重复实验，计算 Pass^3。

完成标准：报告能分别展示触发质量、Agent 轨迹、卡片质量、来源质量、延迟和故障恢复。

### 阶段 3：问题驱动优化

按错误占比排序处理：

1. 先修错误触发和重复卡片。
2. 再修工具参数、搜索结果解析和来源约束。
3. 再修超时、重试和远程兜底标签。
4. 最后优化卡片表达和主题分类。

只有当 baseline 在冻结测试集上暴露出稳定、可重复的问题，才进入 LoRA/SFT。

### 阶段 4：模型训练和 Agent 扩展

第一步训练术语触发器：

```text
转写窗口 -> 候选术语 -> should_surface -> importance -> query
```

第二步再训练端到端 Agent：

```text
转写窗口 -> 决策 -> 工具调用 -> 观察 -> 卡片/跳过/兜底
```

训练数据和冻结测试集必须完全隔离。端到端 Agent 训练不能直接把强模型生成的工具轨迹视为正确轨迹，至少要通过规则校验和人工抽样审核。

## 10. 发布闸门

只有同时满足以下条件，才称为“第一版评估闭环完成”：

- 端到端文件回放和麦克风输入均可运行；
- 本地模型身份、远程兜底身份和数据边界可见；
- 每个 Agent 任务都有完整 trace 或明确失败终态；
- 每候选搜索调用不超过 2 次；
- 工具 Schema 合法率 >= 99%；
- `ToolSafety-Pass^3 = 100%`；
- 触发 Precision >= 80%；
- 卡片事实正确率 >= 92%；
- 来源可追溯率 >= 98%；
- 未授权工具调用、提示注入执行、未确认知识入库均为 0；
- 卡片总延迟 P50 <= 8s，P95 <= 15s；
- 10 分钟演示产生 3～5 张卡片；
- 报告明确展示分母、失败、阻塞和外部未验证项。

如果质量指标通过但真实搜索、ASR 或远程 provider 没有验证，报告必须写“本地/回放闭环通过，外部依赖未验证”，不能写成完整生产可用。

## 11. 简历和面试表达

### 简历一句话

> 构建本地优先的实时会议认知助手，基于本地 ASR、Qwen3-4B/llama.cpp 和 Agent 搜索工具，从中英混合 AI/工程会议中筛选高价值术语并生成带来源的中文上下文卡片；通过结构化 trace、工具调用约束、Pass^3、来源事实性、P50/P95 延迟和提示注入测试建立可复现评估闭环。

### 面试讲解顺序

1. 产品问题：会议术语的有效窗口只有几十秒，深度总结来不及。
2. 架构选择：本地模型负责隐私和低成本，搜索负责补充时效信息，远程模型只在失败时透明兜底。
3. Agent 评估：不只看最终卡片，还看工具选择、参数、调用次数、轨迹、停止条件和失败恢复。
4. 质量约束：搜索来源是证据，不是指令；没有来源的卡片必须标记未验证。
5. 工程指标：触发 Precision/Recall、ToolSafety-Pass^3、端到端成功率、远程兜底比例和 P50/P95 延迟。
6. 数据闭环：公开会议和技术视频用于评估，会后用户确认的卡片进入个人知识库；后续再用真实错误样本训练触发器。

## 12. 与已有文档的关系

- 本文是产品和实施路线总计划。
- `docs/evaluation/context-card-eval-contract.md` 是卡片输入输出、评分、错误标签、量化和报告的详细评估契约；实施时应补充本文第 7 节的 Agent trace 与工具指标。
- `docs/deployment/qwen3-4b-llama-cpp.md` 是本地 Qwen3-4B 和 llama.cpp 部署手册。
- `docs/desktop-mvp.md` 是桌面 MVP 的用户-facing 安装、演示和证据说明。
- 现有 `docs/superpowers/plans/2026-08-21-local-realtime-meeting-copilot.md` 是较早的桌面 MVP 实施草案；其中未在当前源码或真实环境验证的内容只能作为候选方案，不能当成完成证据。

## 13. 当前状态声明

本计划不等于功能已经实现。当前应将项目状态分为：

- 已有代码：当前仓库中已经存在并通过检查的能力。
- 可配置：代码或文档已经预留，但没有完成真实运行闭环的能力。
- 计划实现：本计划后续阶段的工作。
- 外部未验证：真实 Windows 音频、真实本地模型性能、真实搜索 provider、远程兜底和公开视频 ASR 的结果。

最终汇报必须保持这四类状态分离。

## 14. 执行规格与提交规则

### 14.1 本轮范围和模型决定

- 本轮跳过 `whisper-large-zh-cv11` 的下载、安装和对照测试，不把该模型作为当前阶段的前置条件。
- 直接使用当前已选的 `whisper.cpp` 小模型和现有本地配置，优先实现并验证完整链路。
- 当前目标是先完成“本地音频/视频回放 -> 本地 ASR -> 术语识别 -> 联网检索 -> 带来源卡片 -> 会后反馈”的最小闭环；模型替换和大模型对照属于后续独立实验。
- 任何未在本机、固定数据或真实外部依赖上运行的内容，都只能记录为“待验证”，不能写成已完成。

### 14.2 阶段和允许修改范围

阶段编号使用 `P0` 至 `P3`。每个阶段只能修改下表列出的文件；若实现确实需要新增文件，必须先在本阶段计划中登记后再修改。

| 阶段 | 任务 | 允许修改的文件 | 阶段验证命令 | 阶段提交要求 |
| --- | --- | --- | --- | --- |
| P0 规格和基线 | 固化运行契约、事件字段、模型配置、评估入口、状态分类和本阶段边界；不改变产品代码行为 | `docs/plans/2026-08-25-cuemind-detailed-implementation-plan.md`、`task_plan.md`、`progress.md`、`docs/evaluation/context-card-eval-contract.md` | `git diff --check`；`npm run lint`；`npm run build` | 文档检查和现有代码检查通过后，提交一次 `docs: define CueMind execution spec` |
| P1 完整链路 | 接通固定文件回放、本地 `whisper.cpp` ASR、时间戳转写、本地 `llama.cpp`/Qwen3-4B 术语识别、搜索、来源过滤、卡片 Schema、UI 和透明兜底 | `lib/`、`app/`、`components/`、`hooks/`、`desktop/`、`scripts/`；以及为本阶段新增的对应测试文件 | `npm run lint`；`npm run build`；本地 ASR smoke test；固定文件回放命令；卡片 Schema 校验命令 | 文件回放能完成端到端闭环、失败有终态且检查通过后，提交一次 `feat: complete CueMind local replay loop` |
| P2 数据和 replay 评估 | 固定中文视频/会议窗口、生成或审核标注、建立 JSONL replay、记录 Agent trace、运行重复评估并生成报告 | `dataset/`、`docs/evaluation/`、`scripts/`、`fixtures/`、`reports/`；不得在本阶段修改生产链路，除非评估契约明确要求 | JSONL 校验命令；replay 命令；评估脚本；报告完整性检查；必要的 `npm run lint` 和 `npm run build` | 冻结数据集、replay 和报告可重复生成，且报告包含分母、失败和阻塞项后，提交一次 `test: add CueMind replay evaluation` |
| P3 问题驱动优化 | 根据 P2 的可复现错误修复触发、工具参数、来源约束、超时、重试、兜底和卡片表达；不因指标未达标直接进入训练 | 仅允许修改 P1 已登记的生产文件、对应测试文件和 `docs/evaluation/`；训练代码、训练数据和量化产物必须另行登记 | P2 全部评估命令；单元/集成/E2E 检查；提示注入和工具安全测试；延迟 P50/P95 报告 | 修复前后指标可比较、无回归且评估报告更新后，提交一次 `fix: improve CueMind evaluated failure cases` |

P0 只负责规格补充和基线记录，不代表 P1-P3 已经执行。主工作区负责阶段提交；执行者不得在阶段中途提交，也不得提交未通过验证的阶段。

### 14.3 阶段执行顺序

1. P0 完成规格、基线和允许修改范围确认。
2. P1 只实现完整链路，先不做训练和模型对照实验。
3. P2 用固定输入建立可重复评估，先得到错误分布和真实指标。
4. P3 只处理 P2 已经证明且可复现的问题；是否进入训练由 P3 评估结果另行决定。

每个阶段完成前必须记录：实际修改文件、运行命令、通过/失败结果、数据和模型版本、未验证项。阶段提交后再进入下一阶段。

### 14.4 当前待验证能力

以下内容在本规格补充时不视为已完成：

- 当前 `whisper.cpp` 可执行文件、小模型路径和中文视频转写质量；
- ASR 时间戳、音频时长、RTF、首段延迟和长视频稳定性；
- `llama.cpp` 与 Qwen3-4B 本地推理的结构化输出稳定性；
- 真实搜索 provider 的可用性、来源质量、超时和错误终态；
- Agent 工具调用次数、参数合法率、提示注入防护和完整 trace；
- 文件回放、麦克风输入、实时卡片 UI、会后反馈和知识沉淀的端到端连接；
- 本地模型与远程兜底的真实切换行为及隐私边界；
- P50/P95 延迟、卡片数量、触发 Precision/Recall、事实正确率和来源可追溯率；
- Windows 桌面音频采集、打包和真实环境运行结果。
