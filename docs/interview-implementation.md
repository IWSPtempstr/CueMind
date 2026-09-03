# CueMind 本地实时会议知识助手：实现细节

> 本文用于面试准备，描述仓库当前实现，而不是早期设计稿。源码依据主要包括 `app/api/*`、`lib/*`、`hooks/*`、`types/*` 和 `scripts/*`。当前项目是 Next.js 15 App Router 应用，默认使用本地 `llama.cpp`，搜索是唯一默认的外部调用。

## 0. 总体架构

```text
麦克风 / 文件 / Windows 音频助手
        -> 16 kHz mono PCM/WAV
        -> whisper.cpp 或常驻 ASR worker
        -> TranscriptChunk（时间戳、来源、runId）
        -> 30~60 s 候选窗口 + 60 s 上下文
        -> llama.cpp JSON 关键词判断
        -> 本地记忆 + 垂直搜索 + 通用搜索
        -> llama.cpp JSON ContextCard
        -> 引用卡片 / SSE 问答 / SQLite + JSONL Trace
```

核心原则是“证据不足不生成”：关键词不具体、命中已展示关键词、重复候选、来源少于两条、模型超时或 Schema 不合法，均产生明确终态，不把猜测展示成事实。

## 1. 音频接入与实时 ASR

### 模块目标

把不同音频输入统一成带时间信息的转写片段，尽量降低首段延迟并避免录音切片丢字、重复转写和模型进程泄漏。

### 技术实现细节

- 浏览器麦克风使用 `MediaRecorder`，采用“当前 recorder 结束前约 1 秒启动下一个 recorder”的重叠策略。每次 `stop` 得到完整 WebM/Opus 容器，再调用 `/api/local-transcribe`；不用 `timeslice`，因为后续 timeslice blob 可能没有独立容器头。
- 上传媒体先经过 `ffmpeg` 转成 16 kHz、单声道、16-bit PCM WAV。转换和 whisper 子进程都使用临时目录，并在 `finally` 中递归清理。
- `lib/local-asr.ts` 用 `child_process.spawn` 调用 whisper CLI，参数核心为：`-oj -otxt -of <outputBase> -nt`，语言不是 `auto` 时追加 `-l zh/en`；固定追加 `--suppress-nst --max-context 128 --entropy-thold 2.8` 抑制无关噪声和幻觉。
- 领域提示由会议主题和术语表拼成 initial prompt，最大 200 字符，追加 `--prompt` 与 `--carry-initial-prompt`。可选 Silero VAD 只有在模型文件存在时才加入 `--vad --vad-model`。
- whisper 同时输出 JSON 和文本：优先解析 JSON segment 的时间字段，按开始时间排序并拼接文本；JSON 不可用时回退读取 txt。结果统一为 `{ text, segments, latencyMs, audioDurationMs, realTimeFactor, provider, modelPath }`。
- 后处理过滤空片段、`字幕由/Amara.org/谢谢观看/请订阅` 等固定幻觉模式，并把连续三次以上完全相同的片段压缩为一次。
- `ensureWarmedUp` 进程级只执行一次，向同一 ASR 管线送入 500 ms 静音 WAV，提前支付模型加载成本；warmup 失败静默，不阻塞真实请求。
- 桌面常驻模式通过 `RealtimeAsrClient` 向 worker POST 原始 PCM，默认超时 10 s；worker 维护有限队列、模型 hash、设备和 `ready/draining/stopped/error` 状态，worker 失败时回退 CLI。
- `LocalAgreement2` 对连续 partial 结果做本地一致性确认，只有稳定文本推进 `confirmedUntilMs` 才写入已确认转写，避免把不断修订的 partial 当作事实。

关键伪代码：

```ts
const result = await spawn(whisper, args, { timeout: timeoutMs, signal });
const segments = filterHallucinatedSegments(parseJson(result.json));
return segments.length ? join(segments) : readText(result.txt);
```

### 数据流

输入是 `MediaStream`、上传文件或 PCM `Int16Array`；处理包括录音轮转、格式转换、VAD/提示词、whisper 解码、时间戳解析和清洗；输出是 `TranscriptChunk`，含 `id/text/timestamp/source/startMs/endMs/pipelineRunId/latency`，供窗口和问答共用。

### 关键设计决策及理由

完整容器 blob 比 timeslice 更可靠，1 秒重叠比无缝但可能丢掉句尾更可靠；16 kHz mono 是 whisper 输入和 CPU/GPU 推理成本的折中；CLI 进程方案容易部署和隔离，常驻 worker 则用于低延迟场景。浏览器只能可靠获取麦克风，虚拟会议的系统音频需要 Windows WASAPI helper，不能把浏览器 `getDisplayMedia` 方案描述成已解决。

### 异常处理和边界情况

小于 1 KB 的尾部 blob 直接跳过，服务端返回空文本；ASR 超时、abort、命令不存在、非零退出码、JSON 解析失败分别映射为可读错误。Abort 会 kill 子进程，避免孤儿 whisper。VAD 模型缺失降级为无 VAD；队列满时施加背压，重复 chunk ID 不再处理；partial 的 runId 不一致、确认水位回退、重复 confirmed segment 会被协议校验拒绝。

## 2. 转写窗口、关键词候选与实时上下文

### 模块目标

把碎片化转写组织成适合模型判断的有效话题窗口，在 30~60 秒有效窗口内减少重复调用，并为卡片和问答提供短而新鲜的上下文。

### 技术实现细节

- `buildDemoCandidateWindows` 按句末、暂停、说话人变化、语义边界和最大时长关闭窗口；窗口记录 `coreStartMs/coreEndMs`，并向前带最多 2 s overlap 的 context 区间。
- candidate ID 由 `datasetVersion、mediaId、coreStartMs、coreEndMs、asrVersion、windowingVersion` 共同决定，保证回放可复现，而不是用随机文本 hash 导致版本不可追踪。
- 实时卡片上下文默认只取最近 60 s、最多 8 个 chunk；状态还保存 `shownKeywords/currentTopics/unresolvedTopics`。问答只取最近 8 个 chunk、最近 4 轮历史和最多 3 条证据。
- 服务端把 `recentTranscript` 限制在 32,000 字符以内，模型请求和消息分别受 `MAX_PROMPT_CHARS=12,000`、`MAX_MESSAGE_CHARS=8,000` 等上限约束。
- `/api/context-cards` 的关键词调用使用 5 s 超时；模型只返回 `{"keyword":"..."}`。关键词至少两字符，且排除“会议、技术、系统、问题、方案、这个、那个、ai”等泛词；与已知关键词大小写归一化比较，重复候选直接抑制。
- `/api/ask` 的关键词抽取预算更紧，为 1.5 s、最多 3 个关键词、最多 96 tokens；失败时使用 `termHint`，没有提示则进入降级终态。

### 数据流

输入为连续 `TranscriptChunk`；处理为排序、合并、句边界判断、上下文截断、候选去重和关键词结构化抽取；输出为 `CandidateWindow`、`CardContextState` 或问答 `AskContext`，并携带稳定 ID 与窗口版本。

### 关键设计决策及理由

核心窗口和上下文窗口分离，避免把过长历史塞入 Qwen3；字符上限是服务端强制的安全边界，不能依赖浏览器传入的长度；关键词判断先于联网检索，可在最便宜的阶段淘汰噪声。候选账本不删除失败项，保证“每次尝试都有唯一终态”。

### 异常处理和边界情况

时间戳负数、结束时间小于开始时间、context 越过 core、overlap 超限、dataset/windowing 元数据部分缺失均拒绝；实时简单模式若四个时间字段全部缺失，服务端生成 `client-live/hook-1` 元数据，部分缺失则 400。空转写不触发模型，超过最大窗口强制关闭，重复关键词和重复 candidate 分别记录不同抑制原因。

## 3. 本地模型与结构化生成

### 模块目标

统一封装本地 Qwen3 GGUF 的 JSON 推理接口，让关键词、卡片、摘要和问答都输出稳定的应用级对象，而不是在业务层用正则修补自然语言。

### 技术实现细节

- `llama-server` 提供 OpenAI-compatible `/v1/chat/completions`；`lib/model-provider.ts` 统一构造 system/user messages，固定 `temperature: 0` 和 `response_format: {type:"json_object"}`，按任务转发 `max_tokens`。
- 默认 provider 是 `llama.cpp`，服务端默认地址为 `http://127.0.0.1:8082/v1`；远端 OpenAI-compatible provider 必须显式选择，不存在静默云端 fallback。
- 当前运行基线是 Qwen3-8B Q4_K_M，`n_ctx=8192`，全量 GPU offload；旧 4B 配置文档仍保留作历史部署参考，不能当作当前模型口径。Q4_K_M 在 8 GB 显存设备上兼顾模型质量和占用。
- `ModelProviderError` 将错误区分为 `model_unreachable/model_timeout/model_http_error/model_invalid_json/model_schema_invalid`，同时记录 `failureCode`、`stage` 和 HTTP status，但不透出上游 body、密钥或原始错误内容。
- 卡片生成 prompt 明确要求中文、2~4 条短要点、每条不超过 40 字，并把会议转写、本地记忆、搜索结果分别用 untrusted delimiter 包起来，防止来源文本改变系统规则。
- `validateCard` 在路由边界再次校验：对象、keyword、whyNow 必须是字符串；keyPoints 必须是字符串数组，去空、最多保留 6 条；来源必须至少两条并保留来源类型；失败返回 `invalid_schema`，不展示半成品。

### 数据流

输入为 bounded transcript、关键词、来源和运行设置；处理为 provider 解析、JSON 请求、超时/HTTP/解析分类、Schema 校验；输出为 `ContextCard`、问答 SSE 的 `done` 事件，或带 `finalState` 的失败对象。

### 关键设计决策及理由

把“结构化输出”放在 provider 层和 route 层双重约束，分别解决协议统一和业务语义校验；temperature 0 提升 replay 一致性；模型输出短卡片而非长摘要，满足实时阅读；卡片生成进入 `withCardInflight`，让并发问答等待卡片完成，保护卡片 P95。

### 异常处理和边界情况

请求 JSON 非法、模型地址/名称为空、超时、网络错误、非 2xx、空 response、非法 JSON、字段缺失和数组内容错误都产生明确失败码。模型返回多余字段不会被业务使用，关键字段不合法仍拒绝。客户端断开时 SSE 中止；问答 provider 连续无 token 达 30 s 也中止。模型失败不会把原始响应写入日志。

## 4. 多信源检索与 Context Card

### 模块目标

用可解释的关键词检索获取至少两条可用证据，生成秒读、带引用和“为什么此刻出现”的知识卡片。

### 技术实现细节

- `searchKeywordSources` 首先并行访问 arXiv、Hacker News、GitHub、Stack Overflow 四个垂直源，每个源 2.5 s 独立 Abort；结果去重、检查 title/url/snippet、最多保留 5 条。
- 至少两条可用垂直结果时直接返回 `provider:"vertical"`；否则进入通用 Tavily 搜索，查询为 `<keyword> technology explanation`，默认 4 s。Tavily 超时、缺 key、HTTP 失败或来源不足时可选 `agent-reach` fallback。
- 卡片路线最多尝试两次检索，第二次主要处理 `InsufficientSearchSourcesError`；搜索成功结果写入 ask cache，缓存写失败不影响主链路。
- prompt 只注入最多两条来源，每条 title 最多 300、snippet 最多 1,200 字符；生成结果必须带两条原始 URL。来源类型语义写入提示：论文是研究结论，GitHub 是仓库用途/热度语境，社区内容不是权威定义。
- 一个候选始终落入账本状态：`card_shown`、`model_skip`、`suppressed_as_duplicate`、`search_failed`、`model_failed`、`invalid_schema`、`timeout` 等。Trace 记录 stage、provider、retry、verticalHit 和总时延，不保存完整转写。

### 数据流

输入为候选窗口、关键词判断上下文、已知候选和设置；处理为本地记忆查询、垂直搜索、通用 fallback、来源裁剪、Qwen 结构化生成和引用校验；输出为 `ContextCard {keyword,keyPoints,whyNow,sources,latencyMs,transcriptChunkIds}` 或失败/终态 Trace。

### 关键设计决策及理由

垂直源优先能提升技术术语的相关性且不依赖搜索 key；“至少两条可用来源”是防幻觉门槛；并行请求降低总等待时间；来源类型保留到卡片层，避免把社区观点包装成事实；缓存只按关键词单向复用，降低重复外发。

### 异常处理和边界情况

单个源超时不会拖死其他源，垂直源不足才 fallback；所有来源失败或少于两条时 fail-closed，不调用卡片生成。无效 URL、空标题、重复 URL、空 snippet 被丢弃。来源和转写都标为不可信数据，prompt injection 只影响证据内容，不可改写工具调用、隐私或输出契约。

## 5. 即时问答与会话上下文

### 模块目标

允许用户围绕会议内容或卡片继续提问，快速返回带来源回答，并在卡片生成占用本地模型时保持资源公平。

### 技术实现细节

- `/api/ask` 先等待 `cardInflight`，最多 15 s，每 100 ms 轮询；超时后带 warning 继续，避免问答永久饿死。
- 关键词抽取失败先走 `termHint`，再决定是否降级；搜索复用卡片检索、term cache 和同样的垂直源/fallback 策略。
- 模型回答使用 SSE。服务端先缓冲上游 token，只有当最终 JSON Schema 校验通过后才把答案切成最多 24 字符的片段发给客户端，避免先显示无法引用的错误答案。
- Ask Schema 至少要求 answer、confidence 和至少一条模型实际引用的输入来源；最终 `done` 事件合并引用来源与搜索来源，最多 5 条，来源不足时返回 degraded。
- 上下文压缩触发条件是 prompt 达 context window 的 60%、问答达到 5 轮或会议超过 10 分钟；压缩失败回退到确定性历史裁剪。聊天历史硬上限 20 条消息。

### 数据流

输入为 question、可选 termHint、最近转写、卡片/决策引用和历史；处理为限长、关键词抽取、缓存/检索、引用型 JSON 生成、Schema 校验和 SSE 编码；输出为 `searching/degraded/pipeline_event/done` 等事件，并持久化 user/assistant 消息。

### 关键设计决策及理由

SSE 提供较低首事件延迟，同时服务端缓冲保障引用和 Schema 完整性；问答与卡片共享搜索缓存和来源类型，保证同一关键词解释一致；长期记忆依赖 transcript/card/decision 摘要，不无限增长聊天 prompt。

### 异常处理和边界情况

问题为空、body 非对象或超过长度返回 400；无关键词且无 termHint 不联网并降级；搜索少于两条不生成无依据答案；用户主动取消或连接断开时终止上游；30 s 无 token 触发 idle timeout；Schema 失败、模型失败分别记录终态，缓存读写失败均旁路处理。

## 6. SQLite 持久化、全文检索与知识沉淀

### 模块目标

保存会话、转写、卡片尝试和问答全链路，并支持按会话恢复、全文搜索、跨会话卡片/决定复用和 JSONL/Markdown 导出。

### 技术实现细节与数据库设计

数据库目录由 `CUEMIND_DATA_DIR` 指定，默认 `<cwd>/.data`；`better-sqlite3` 动态加载，开启 WAL。native 模块不可加载时切换 append-only JSONL，保持相同 API。

```sql
sessions(id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT,
  duration_ms INTEGER, input_source TEXT, transcript_json TEXT,
  cards_json TEXT, metrics_json TEXT)
chat_messages(id TEXT PRIMARY KEY, session_id TEXT,
  role TEXT CHECK(role IN ('user','assistant')), content TEXT,
  is_detail INTEGER, created_at TEXT, sources_json TEXT,
  keywords_json TEXT, final_state TEXT)
candidates(session_id TEXT, candidate_id TEXT, term TEXT, final_state TEXT,
  suppress_reason TEXT, card_id TEXT, created_at TEXT,
  PRIMARY KEY(session_id,candidate_id))
knowledge_memory(id TEXT PRIMARY KEY, kind TEXT, record_json TEXT,
  title TEXT, search_text TEXT, status TEXT, valid_until TEXT,
  updated_at TEXT)
```

`sessions.updated_at`、chat session/time、candidate session/time 和 candidate term 建索引；`sessions_fts`、`knowledge_memory_fts` 使用 FTS5。中文检索先把连续 CJK 字符切成二元组，ASCII 连续串按词切分并小写，解决 SQLite 默认 tokenizer 对中文不友好的问题。知识记忆支持 `knowledge_card` 和显式 `meeting_decision` 两种记录，状态只有 `active` 且未过期才可进入卡片 prompt；精确关键词、alias 命中优先于 FTS。

写入使用 prepared statement 和事务；同一 ID `INSERT OR REPLACE` 保持幂等。候选账本、pipeline event 和部分会话写入采用 fire-and-forget，任何存储故障都不能阻塞卡片实时链路。

### 数据流

输入是 `SessionSnapshot`、聊天消息、候选终态、卡片来源和会议决定；处理是日期序列化、JSON 字段封装、事务 upsert、FTS token 化；输出是会话列表/搜索结果、MCP 只读查询、JSON/Markdown 导出和可复用的 `MemoryHit`。

### 关键设计决策及理由

SQLite 足以覆盖单机本地助手，WAL 提升读写并发；JSONL 是 native sqlite 失败时的可恢复降级；contentless FTS5 减少重复存储，更新时使用 delete 命令并按同样 token 规则回放；服务端数据目录统一，避免不同 store 写出多份数据库。

### 异常处理和边界情况

动态加载失败、数据库初始化失败或测试显式设置 `CUEMIND_*_STORE=jsonl` 时降级；JSONL 读取跳过坏行并采用同 ID 最后一条记录；未知/无效日期回退到创建时间；空查询直接返回空数组；删除或覆盖 FTS 行时保持索引与主表同步。加载 `SessionSnapshot` 必须显式 revive Date，不能直接把 JSON 字符串当 Date 使用。

## 7. Trace、回放、性能与可靠性

### 模块目标

让实时链路可定位、可复现、可量化，并把“模型不可用”和“功能质量不足”区分开。

### 技术实现细节

- 每次运行有 `runId/traceId`，pipeline event 只允许固定事件名、单调时间戳和有限 metadata，metadata 仅保留 source/status/reason/errorCode，主动排除 transcript、prompt 和 secret。
- `request-timeline` 计算 capture、ASR、keyword、search、generation、render 和 total 阶段；percentile 使用排序后 `ceil(p*n)-1` 取值。
- `buildDemoCandidateWindows` 与 `validate-replay` 读取冻结 JSONL，检查坏行、重复 ID、时间水位、空文本、覆盖时长、终态唯一性和账本守恒；支持 mock/live 两种模式，报告明确标注证据边界。
- 通过 `scripts/test-*` 覆盖本地 ASR、模型 provider、垂直源、卡片路由、问答路由、SQLite/JSONL store、并发让位、replay 和资源压力。

### 性能指标与当前证据

目标口径是：关键词判断 P95 不超过 2.7 s；关键词到卡片生成 P50 不超过 5.4 s；即时问答完成率至少 95%。当前代码预算为关键词 5 s、卡片搜索 4 s、卡片生成 8 s、Ask 关键词 1.5 s、Ask idle 30 s。已记录的本地 llama.cpp 8B 固定测试为 24/24 成功，首上游 token P50/P95 约 34.8/137.3 ms，completion P50/P95 约 710/893 ms；这是固定 prompt 烟测，不等于生产 SLA。固定卡片评测的总时延 P50/P95 约 1.87/3.08 s，但它是 synthetic fixed-source，不代表真实联网质量。

### 数据流

输入为每阶段事件和候选终态；处理为 JSONL 追加、回放、聚合 P50/P95、失败计数和资源采样；输出为 trace、scorecard、Markdown 报告和 UI 上的有限健康指标。

### 关键设计决策及理由

阶段级 Trace 比只记总耗时更容易定位瓶颈；固定 dataset/windowing/asr 版本让模型和窗口策略可 A/B；失败也必须有终态，避免只统计成功样本造成虚假的完成率；遥测不带原文，符合本地优先和隐私边界。

### 异常处理和边界情况

事件乱序、重复、跨 runId、未知事件名或不安全 metadata 会被拒绝/过滤；Trace 写盘失败只影响观测不影响功能；回放报告把 `live_search_unavailable`、`live_context_card_runtime_unverified` 等外部依赖单独列出。显存不足、模型重启、不可写目录、来源超时均要求保留降级状态和恢复信息。

## 8. 安全、部署与面试中的事实边界

### 模块目标

保证本地运行时不把会议内容和密钥泄露给浏览器或日志，同时让部署、回滚和能力限制可解释。

### 技术实现细节

API 路由统一执行按 IP 的 burst rate limit、请求长度 clamp 和 JSON 解析校验；Next 配置设置 CSP、X-Frame-Options、MIME sniffing、Referrer 和麦克风权限相关 header。模型 key 与设置分开存储。上传媒体服务端验证真实 WebM/WAV container header 后再转换，临时文件不写入仓库。默认只把关键词发送给外部搜索，不发送完整会议文本；卡片和问答 prompt 对外部结果做 untrusted 标记。

本地服务可用 Docker/systemd 管理，模型目录只读挂载，数据与 trace 写 volume；升级前保存 image tag、模型 hash 和评测报告，回滚由人工指定模型，不自动换模。GPU 运行应确认 `nvidia-smi` 中 llama-server 使用显存且没有 CUDA 初始化失败。

### 数据流

浏览器仅访问同源 `/api/*`；音频和模型请求留在本机；搜索阶段只外发关键词；结果经裁剪和校验后回到卡片/问答；数据写本地 SQLite/JSONL。

### 关键设计决策及理由

本地模型降低会议原文外发风险，服务端代理避免把 provider 配置和密钥打进 bundle；fail-closed 比“没有来源也回答”更适合知识助手；模型/数据/评测版本绑定有利于复盘和回滚。

### 异常处理和边界情况

限流返回错误不触发模型；超长上下文服务端截断；上传伪造扩展名会被容器头校验拒绝；模型错误只返回安全错误族；外部搜索不可用时显示降级，不伪造引用。当前 Windows helper、安装包、长视频稳定性、真实线上搜索质量仍需目标机器验收，不能在面试中说成已完成生产 SLA。

## 9. 简历描述与当前代码的差异

1. 简历写 SQLite 是正确方向，但当前会话、聊天、候选和知识记忆是多个 store 共享同一个 `cuemind.db`，并非单一 ORM 模型；native sqlite 失败还有 JSONL fallback。
2. 简历中的“多源知识库”当前主要是联网垂直源加本地知识记忆；Milvus/embedding 检索已移出实时主链路，不应作为当前实现亮点。
3. 简历写 Qwen3-8B 与当前运行基线一致；仓库仍有 4B 历史部署文档和旧脚本默认值，面试时应说明 8B 是经过 A/B 后的运行基线。
4. “30~60 秒有效窗口”应表述为候选窗口与上下文窗口策略，实际实时简单 hook 会使用服务端合成的 `client-live/hook-1` 元数据。
5. “500+ 冻结样本、P95/P50/完成率”属于目标/评测口径，只有在对应报告给出真实 denominator、运行模式和依赖状态时才可称为实测；固定 synthetic 或 mock 报告不能外推为生产质量。

## 10. 面试时的一句话总结

我把系统拆成“本地 ASR、短窗口候选、结构化模型、可解释检索、引用卡片、SSE 问答、SQLite 账本和 JSONL 回放”八个边界；每个边界都有长度/时间/Schema 校验，并且无论成功还是失败都写入可追踪终态，从而在本地模型和网络都不稳定时仍能给出可解释、可恢复的会议辅助结果。
