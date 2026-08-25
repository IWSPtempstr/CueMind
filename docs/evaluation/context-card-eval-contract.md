# CueMind Context Card 评估契约

## 1. 目的与范围

本契约用于评估 CueMind 的实时会议认知辅助链路：

```text
会议转写片段
  -> 候选关键词识别
  -> 是否值得生成卡片
  -> Web 来源检索
  -> 中文解释卡生成
  -> 结构校验与来源约束
  -> 延迟、失败和回放记录
```

评估对象不是“模型会不会聊天”，而是模型和检索管线能否在会议话题窗口内，稳定生成一张**短、相关、有来源、可追溯**的上下文卡片。

本契约覆盖：

- 当前本地 Ollama 关键词抽取和卡片生成；
- 搜索增强后的来源质量；
- 失败、超时、重试和降级；
- replay 模式下的确定性回归；
- 后续 `qwen3:4b`、SFT、DPO、量化模型和远程模型的统一比较。

本契约不把“真实 Windows 音频采集”和“真实搜索服务”伪装成已经完成的证据。相关门槛必须在真实运行时单独闭合。

## 2. 当前系统基线

当前实现以以下文件为准：

- API 链路：[app/api/context-cards/route.ts](../../app/api/context-cards/route.ts)
- Ollama JSON 适配器：[lib/ollama.ts](../../lib/ollama.ts)
- 卡片类型：[types/suggestions.ts](../../types/suggestions.ts)
- 卡片触发和延迟采集：[hooks/useContextCards.ts](../../hooks/useContextCards.ts)
- 延迟统计：[lib/telemetry.ts](../../lib/telemetry.ts)
- 回放页面：[app/replay/page.tsx](../../app/replay/page.tsx)
- 合成回放样例：[fixtures/demo-meeting/sample-events.jsonl](../../fixtures/demo-meeting/sample-events.jsonl)
- MVP 验收边界：[docs/desktop-mvp.md](../desktop-mvp.md)

当前卡片输出结构：

```ts
interface ContextCard {
  id: string;
  keyword: string;
  explanation: string;
  whyNow: string;
  sources: [ContextCardSource, ContextCardSource];
  createdAt: Date;
  transcriptChunkIds: string[];
  latencyMs: {
    keyword: number;
    search: number;
    generation: number;
    total: number;
  };
}
```

当前目标：

- 一次会议产生 3-5 张有效卡片；
- 10 分钟技术会议包含 8-12 个候选技术术语；
- 卡片总延迟 `P50 <= 8s`；
- 卡片总延迟 `P95 <= 15s`；
- 每张卡片包含两个来源链接；
- 原始音频和本地转写不发送给远程模型；
- 搜索服务只接收关键词或短查询。

## 3. 任务契约

### 3.1 输入契约

每个评估样本必须至少包含：

```json
{
  "id": "cc-001",
  "input": {
    "recentTranscript": "今天我们比较 RAG 和 fine-tuning 在企业知识库中的取舍。",
    "knownKeywords": [],
    "transcriptChunkIds": ["t-001", "t-002"],
    "currentTime": "2026-08-25T10:00:00+08:00"
  },
  "expected": {
    "decision": "generate_card",
    "keyword": "RAG",
    "keyword_class": "technical_concept",
    "why_now_evidence": ["RAG"],
    "source_requirements": {
      "min_usable_sources": 2,
      "must_have_url": true
    }
  },
  "tags": ["technical_term", "acronym", "comparison"]
}
```

输入字段规则：

| 字段 | 要求 |
| --- | --- |
| `id` | 冻结后不可复用；建议使用稳定业务含义 ID |
| `recentTranscript` | 只包含评估时实际可见的最近转写，不得混入 expected |
| `knownKeywords` | 只包含此前已展示的关键词，用于测试去重 |
| `transcriptChunkIds` | 必须能回指真实或合成转写片段 |
| `currentTime` | 固定时区和格式，用于记录和复现实验 |
| `expected` | 评估标签，不得进入模型 prompt |
| `tags` | 场景切片标签，可多选 |

### 3.2 决策契约

候选关键词识别阶段允许两种结果：

```text
generate_card
skip
```

`skip` 适用于：

- 没有新的具体技术关键词；
- 关键词已在 `knownKeywords` 中；
- 关键词过于泛化；
- 转写不足以支持可靠检索；
- 检索没有达到最小来源门槛；
- 请求超时或服务不可用。

`skip` 不是失败。只有在 expected 要求 `generate_card` 且系统无合理降级原因时，才计为任务失败。

### 3.3 卡片结构契约

成功输出必须满足：

```json
{
  "keyword": "RAG",
  "explanation": "RAG 是先检索相关资料，再让语言模型基于资料生成回答的方法。",
  "whyNow": "会议正在比较 RAG 与 fine-tuning 的企业知识库落地方式。",
  "sources": [
    {
      "title": "source title",
      "url": "https://example.com/source-1",
      "snippet": "source snippet"
    },
    {
      "title": "source title",
      "url": "https://example.com/source-2",
      "snippet": "source snippet"
    }
  ]
}
```

必须满足：

- `keyword`、`explanation`、`whyNow` 是非空字符串；
- `sources` 恰好两个元素；
- 每个来源包含非空 `title`、合法 `url` 和非空 `snippet`；
- 卡片的关键词不能无故替换为与输入无关的概念；
- `explanation` 不得声称来源未支持的事实；
- `whyNow` 必须回扣当前会议片段，而不是泛泛解释关键词；
- 卡片必须记录对应的 `transcriptChunkIds`；
- 每个阶段和总延迟必须是非负数。

## 4. 冻结评估集

### 4.1 数据集分层

评估集分为三层，不能混用：

| 数据集 | 用途 | 是否参与训练 |
| --- | --- | --- |
| `eval/frozen` | 发布闸门和模型比较 | 否 |
| `eval/challenge` | 发现新问题和构造 hard case | 否，除非重新切分并版本化 |
| `train/raw` | SFT/DPO 数据生成和训练 | 是 |

冻结集一旦用于报告，不得再用于：

- SFT 训练；
- DPO chosen/rejected 构造；
- 量化 calibration 文本；
- prompt 调参后的人工挑选；
- 远程教师模型直接生成目标答案。

如果冻结集发生修改，必须升级版本，例如 `context-card-eval-v1.1`，并重新记录 SHA256。

### 4.2 首版规模

首版建议至少 80 条：

| 场景 | 最少数量 |
| --- | ---: |
| 新的具体技术术语 | 15 |
| 中文/英文混合术语 | 10 |
| 缩写和别名 | 10 |
| 多义词和泛化词 | 10 |
| 已知关键词去重 | 8 |
| 无新关键词或不应出卡 | 8 |
| 搜索结果不足或冲突 | 8 |
| Ollama 非法 JSON/超时 | 5 |
| 来源与解释不一致 | 6 |

其中至少 20 条来自真实或脱敏的会议转写片段；没有真实数据时，可以先使用人工编写的合成样本，但报告必须标记 `synthetic_only`。

### 4.3 样本标签

每条样本至少包含：

```json
{
  "id": "cc-001",
  "version": "context-card-eval-v1",
  "input": {},
  "expected": {},
  "tags": [
    "technical_term",
    "chinese_english_mix",
    "should_generate"
  ],
  "difficulty": "medium",
  "source": "synthetic",
  "notes": "关键词必须保持为 RAG，不应泛化成 AI"
}
```

推荐标签：

- `technical_term`
- `framework`
- `model`
- `paper`
- `company`
- `acronym`
- `chinese_english_mix`
- `ambiguous`
- `generic_term`
- `duplicate_keyword`
- `should_generate`
- `should_skip`
- `source_conflict`
- `insufficient_sources`
- `ollama_timeout`
- `invalid_json`
- `long_context`

## 5. 评分体系

质量和实时性分开统计。不要把一个未经验证的“综合分”当作产品是否可用的唯一结论。

### 5.1 协议分数

```text
protocol_score =
  0.40 * json_valid
  + 0.30 * card_schema_valid
  + 0.20 * source_schema_valid
  + 0.10 * trace_fields_valid
```

每项取 `0` 或 `1`：

- `json_valid`：模型输出可解析为 JSON；
- `card_schema_valid`：卡片字段、类型和数量正确；
- `source_schema_valid`：两个来源的 URL、标题、摘要完整；
- `trace_fields_valid`：片段 ID 和延迟字段可追溯。

协议分数用于回答“系统是否按约定输出”，不代表解释内容正确。

### 5.2 关键词任务分数

```text
keyword_score =
  0.45 * exact_or_alias_match
  + 0.25 * specificity
  + 0.20 * transcript_grounded
  + 0.10 * novelty
```

判定规则：

- `exact_or_alias_match`：关键词与 expected 完全一致，或命中人工维护的别名表；
- `specificity`：不能只输出“AI”“系统”“技术”“模型”等泛化词；
- `transcript_grounded`：关键词在转写中出现，或能通过明确同义词规则回指转写；
- `novelty`：关键词不在 `knownKeywords` 中。

语义 embedding 只能作为辅助，不得单独判定事实正确。首版建议使用规则、别名表和人工复核。

### 5.3 卡片内容分数

```text
card_content_score =
  0.30 * explanation_correct
  + 0.25 * why_now_relevant
  + 0.25 * evidence_supported
  + 0.10 * concise
  + 0.10 * audience_appropriate
```

判定标准：

- `explanation_correct`：解释没有明显概念错误；
- `why_now_relevant`：说明当前会议为什么提到该词；
- `evidence_supported`：关键断言能在来源标题或摘要中找到支持；
- `concise`：解释和 `whyNow` 适合几秒内阅读；
- `audience_appropriate`：对不了解该词的会议参与者足够清楚，但不扩写成教程。

建议初始长度约束：

- `explanation`：20-80 个中文字符或 15-60 个英文词；
- `whyNow`：15-60 个中文字符或 10-40 个英文词；
- 超出范围先标记 `too_verbose`，不要立即作为硬失败，待真实用户测试后再确定阈值。

### 5.4 来源分数

```text
source_score =
  0.35 * usable_source_count
  + 0.25 * url_valid
  + 0.20 * source_diversity
  + 0.20 * claim_support
```

来源要求：

- 至少两个可访问来源；
- URL 必须是完整 HTTP(S) URL；
- 两个来源不能只是同一页面的重复搜索结果；
- 来源摘要必须与关键词相关；
- 卡片中的关键事实不能超过来源支持范围。

当前 MVP 只记录来源元数据，尚未自动抓取全文验证引用。因此 `claim_support` 首版可以采用人工抽检，并在报告中标记 `manual_audit`。

### 5.5 决策和降级分数

```text
decision_score =
  0.60 * correct_generate_or_skip
  + 0.20 * graceful_failure
  + 0.20 * no_hallucinated_card
```

正确行为包括：

- 没有新关键词时不生成空泛卡片；
- 搜索来源不足时跳过或返回明确失败；
- Ollama 超时后不阻塞后续会议转写；
- 非法 JSON 不进入 UI；
- 失败记录包含原因和转写片段 ID。

### 5.6 总体报告

报告至少展示以下独立指标：

```text
protocol_score
keyword_score
card_content_score
source_score
decision_score
card_success_rate
graceful_failure_rate
unsupported_claim_rate
```

不建议首版设置一个“综合分 winner”。如果必须排序，使用明确的门槛式规则：

1. `protocol_score` 达到门槛；
2. `unsupported_claim_rate` 不超过门槛；
3. `card_success_rate` 达到门槛；
4. 在合格模型中比较 P50/P95 延迟和资源占用。

## 6. 错误标签

每个失败样本必须保留机器可读的错误标签，不能只写一段自然语言日志。

### 6.1 关键词阶段

- `invalid_keyword_json`
- `missing_keyword`
- `generic_keyword`
- `keyword_not_grounded`
- `duplicate_keyword`
- `wrong_keyword_alias`
- `should_skip_but_generated`

### 6.2 检索阶段

- `search_timeout`
- `search_http_error`
- `insufficient_sources`
- `duplicate_sources`
- `invalid_source_url`
- `irrelevant_source`
- `source_conflict`

### 6.3 生成阶段

- `ollama_timeout`
- `ollama_http_error`
- `invalid_card_json`
- `missing_explanation`
- `missing_why_now`
- `wrong_keyword_in_card`
- `too_verbose`
- `unsupported_claim`
- `why_now_not_relevant`

### 6.4 系统阶段

- `request_validation_error`
- `retry_exhausted`
- `render_failure`
- `replay_mismatch`
- `missing_trace_id`
- `latency_budget_exceeded`

一个样本可以有多个标签。报告必须同时保存：

```text
sample_id
model_id
prompt_version
dataset_version
error_labels
raw_output
validated_output
latency
source_metadata
```

## 7. 实时性与资源指标

质量评分不替代实时性指标。每次运行按模型、硬件、运行时和 workload 记录：

```text
keyword_ms
search_ms
generation_ms
total_ms
request_count
success_count
failure_count
retry_count
peak_memory_mb
model_file_size_bytes
tokens_per_second
```

至少报告：

- `count`
- `mean`
- `p50`
- `p95`
- `min`
- `max`

### 7.1 延迟门槛

当前产品目标：

| 指标 | 目标 |
| --- | ---: |
| 卡片总延迟 P50 | `<= 8000 ms` |
| 卡片总延迟 P95 | `<= 15000 ms` |
| 搜索请求超时 | `4000 ms` 单次 |
| 关键词模型超时 | `5000 ms` |
| 卡片模型超时 | `8000 ms` |
| 卡片冷却时间 | 当前设置驱动，评估时必须固定 |

这些是产品预算，不是已经完成的实测结果。真实 Ollama、真实搜索 API 和 Windows 打包环境未完成前，报告必须标记 `externally_unverified` 或 `pending`。

### 7.2 对比运行规则

比较不同模型时固定：

- 相同评估集；
- 相同 prompt 版本；
- 相同上下文截断长度；
- 相同 `temperature`；
- 相同输出 token 上限；
- 相同搜索结果快照，或明确标记为 live-search；
- 相同硬件；
- 相同 Ollama/llama.cpp 版本；
- 相同 cold/hot 运行模式。

`live-search` 结果不适合严格模型回归，因为搜索页面会变化。质量回归应优先使用保存过的来源快照。

## 8. 数据集构建与审计

### 8.0 Fixture replay 基线

`scripts/validate-replay.ts` 用于在真实模型和外部服务未就绪时检查 JSONL 回放输入的完整性。它输出 `manifest.json`、`scorecard.json` 和 `report.md`，至少报告：

- 有效事件数、转写事件数和无效行数；
- 事件 ID 重复数；
- 转写片段的时间范围和空文本数；
- fixture 中已提供的 ASR 延迟 `count/min/max/mean/P50/P95`。

该脚本的 `pass` 只表示 fixture 事件结构和元数据通过校验，不表示 whisper.cpp 转写质量、本地模型结构化输出、实时搜索质量、卡片事实正确性或端到端延迟通过。报告必须保留 `fixture_replay` 数据集类型和外部证据阻塞项。

### 8.1 推荐构建流程

```text
人工/真实转写采集
  -> 脱敏
  -> 关键词和卡片标签
  -> 来源快照
  -> JSON Schema 校验
  -> 去重
  -> train/eval overlap 检查
  -> 版本化 + SHA256
  -> 冻结
```

### 8.2 数据质量检查

每次生成或修改数据集必须检查：

- ID 唯一；
- `expected` 不为空；
- `should_generate` 样本包含关键词和来源要求；
- `should_skip` 样本没有被错误标为可生成；
- `transcriptChunkIds` 有效；
- 训练集与冻结评估集无 ID、文本和来源 URL 重叠；
- 没有把 expected、人工评分或测试答案拼入模型输入；
- JSON 可解析；
- 版本和 SHA256 已更新。

### 8.3 合成数据边界

可以使用强模型生成训练样本，但必须：

- 保存生成 prompt 和模型版本；
- 对 hard case 做人工抽检；
- 不让强模型直接决定冻结评估集的最终答案；
- 对 rejected 样本记录具体错误原因；
- 保留真实转写样本作为独立验证来源。

## 9. 基线和后训练矩阵

### 9.1 第一阶段：不训练

先比较：

| 模型 | 运行时 | 目的 |
| --- | --- | --- |
| 当前默认模型 | Ollama | 现有行为基线 |
| `qwen3:4b` | Ollama | 本地质量/延迟基线 |
| `qwen3:4b` 量化版本 | Ollama | 体积和速度基线 |
| 远程强模型 | API | 质量上界参考 |

第一阶段必须先定位错误集中在哪：

- 格式不稳定；
- 关键词选错；
- 卡片过长；
- `whyNow` 泛化；
- 来源不足；
- 来源支持不了断言；
- 搜索延迟过高。

### 9.2 第二阶段：SFT

只有当主要问题是格式、输出风格或固定任务行为时，才做 LoRA/QLoRA SFT。

SFT 样本建议包含：

```json
{
  "input": "会议片段和来源",
  "output": {
    "keyword": "RAG",
    "explanation": "...",
    "whyNow": "..."
  }
}
```

SFT 目标：

- 稳定输出合法 JSON；
- 稳定选择具体关键词；
- 控制卡片长度；
- 让 `whyNow` 与当前片段关联；
- 在来源不足时选择 `skip`。

### 9.3 第三阶段：DPO

DPO 只针对基线和 SFT 暴露的具体错误构造偏好对：

```text
preferred:
  短、准确、与来源一致、whyNow 具体

rejected:
  泛化、冗余、来源不支持、重复关键词、过度推断
```

不要为了“有 DPO”而生成大量随机 rejected。每条 rejected 必须有：

```text
rejection_reason
error_labels
source_case_id
```

如果 SFT 后 `unsupported_claim_rate` 仍高，优先改来源抽取和事实校验，不要默认继续加大 DPO。

## 10. 模型合并、量化与部署评估

### 10.1 推荐流水线

```text
Base model
  -> LoRA/QLoRA adapter
  -> merge_and_unload
  -> HF merged model
  -> F16/BF16 GGUF anchor
  -> domain calibration text
  -> imatrix
  -> Q4_K_M / Q5_K_M / Q8_0
  -> Ollama import
  -> frozen eval + latency eval
```

训练量化和部署量化要分开记录：

- QLoRA 的 NF4 是训练阶段的显存优化；
- GGUF `Q4_K_M`、`Q5_K_M`、`Q8_0` 是部署阶段的权重量化；
- imatrix 是量化校准统计，不是模型权重。

### 10.2 每个模型必须登记

```json
{
  "model_id": "cuemind-qwen3-4b-sft-q4-k-m-v1",
  "base_model": "Qwen/Qwen3-4B",
  "base_revision": "固定 revision",
  "adapter": "optional adapter run id",
  "parent_model_id": "optional",
  "training_stage": "base|sft|dpo",
  "quant_type": "f16|q4_k_m|q5_k_m|q8_0",
  "calibration_data_version": "context-card-calibration-v1",
  "calibration_sha256": "sha256",
  "runtime": "ollama",
  "runtime_version": "version",
  "prompt_version": "context-card-prompt-v1",
  "model_sha256": "sha256"
}
```

### 10.3 量化验收

量化模型不能只比较文件大小。必须和 F16/BF16 anchor 在相同评估集上比较：

- 协议分数；
- 关键词分数；
- 卡片内容分数；
- 来源分数；
- unsupported claim rate；
- P50/P95；
- 峰值内存；
- 文件大小。

首版建议：

1. 先跑 F16 anchor；
2. 跑 `Q8_0`；
3. 跑 `Q5_K_M`；
4. 跑 `Q4_K_M`；
5. 如果关键质量指标回退，再上调位宽，不要只因速度更快就选 Q4。

## 11. 报告格式

每次评估至少生成三个文件：

```text
reports/context-card/<run-id>/manifest.json
reports/context-card/<run-id>/scorecard.json
reports/context-card/<run-id>/cases.jsonl
```

### 11.1 manifest

必须包含：

```json
{
  "run_id": "2026-08-25-qwen3-4b-baseline",
  "status": "complete|partial|blocked|failed",
  "dataset_version": "context-card-eval-v1",
  "dataset_sha256": "sha256",
  "prompt_version": "context-card-prompt-v1",
  "model_id": "qwen3:4b",
  "runtime": "ollama",
  "hardware": "RTX 4060 Ti 8GB",
  "started_at": "2026-08-25T10:00:00+08:00",
  "completed_at": "2026-08-25T10:20:00+08:00",
  "failure_count": 0
}
```

### 11.2 scorecard

至少包含：

```json
{
  "protocol_score": 0.0,
  "keyword_score": 0.0,
  "card_content_score": 0.0,
  "source_score": 0.0,
  "decision_score": 0.0,
  "card_success_rate": 0.0,
  "graceful_failure_rate": 0.0,
  "unsupported_claim_rate": 0.0,
  "latency": {
    "keyword_p50_ms": null,
    "search_p50_ms": null,
    "generation_p50_ms": null,
    "total_p50_ms": null,
    "total_p95_ms": null
  },
  "slices": {}
}
```

### 11.3 单样本记录

每条记录必须能回答：

```text
输入是什么？
模型看到了什么？
输出是什么？
是否通过协议？
错误在哪里？
来源是什么？
用了多长时间？
是否重试？
是否能复现？
```

## 12. 执行顺序

### 阶段 A：契约和数据

1. 创建 `eval` 样本 JSONL 和版本文件。
2. 固定 80 条首版评估集。
3. 写 JSON Schema 或等价校验器。
4. 对每条样本打场景标签和难度。
5. 生成 SHA256 和数据卡片。

### 阶段 B：基线

1. 用当前模型跑一次 replay/fixture smoke。
2. 用真实 Ollama 跑 10 条小样本。
3. 用完整冻结集跑 `qwen3:4b`。
4. 保存逐样本输出、错误标签和延迟。
5. 再决定问题属于 prompt、检索、运行时还是训练数据。

### 阶段 C：训练决策

```text
格式/风格问题      -> SFT
偏好/冗余/幻觉问题  -> DPO
来源不支持断言      -> 检索与事实校验
延迟问题            -> 模型尺寸、量化、并行和缓存
关键词触发问题      -> 规则门控 + SFT，不能只靠 DPO
```

### 阶段 D：量化和发布候选

1. 合并 LoRA；
2. 保存 F16/BF16 anchor；
3. 生成领域 calibration 文本；
4. 生成 Q4/Q5/Q8；
5. 重新跑冻结评估集；
6. 只有质量和延迟都满足门槛，才注册为发布候选。

## 13. 当前状态与证据边界

### 已有实现

- ContextCard 类型和结构化 API 返回；
- Ollama JSON 请求；
- 关键词和卡片分阶段延迟；
- 搜索重试；
- 来源链接；
- 失败行；
- replay 页面和合成事件 fixture；
- P50/P95 延迟展示。

### 当前可配置但未完成闭环

- 真实 Ollama 模型基线；
- 真实搜索服务双来源验证；
- 10 分钟会议完整回放；
- 按模型版本保存逐样本评估报告；
- 来源事实支持的自动化检查；
- F16/Q4/Q5/Q8 模型矩阵。

### 当前不能宣称

- “本地模型已经达到生产质量”；
- “Q4_K_M 是 CueMind 的最佳量化方案”；
- “SFT/DPO 一定提升卡片质量”；
- “实时延迟已经满足 P50/P95 目标”；
- “系统是完全离线”。

系统当前定位仍是：

```text
本地音频/转写/模型推理
+ 关键词级 Web 搜索增强
```

而不是完全离线助手。

## 14. 最小验收门槛

首个可写进简历的评估闭环至少应满足：

- 冻结评估集不少于 80 条；
- 训练集与评估集无重叠；
- 每条样本有稳定 ID、标签和 expected；
- 逐样本保存 raw output、validated output 和错误标签；
- 协议分数、卡片内容分数、来源分数、延迟分开报告；
- 至少完成当前模型和 `qwen3:4b` 的同口径基线；
- 至少完成一次真实 Ollama + 真实搜索的 10 条 smoke；
- 至少保存一份可重放的 JSONL 运行记录；
- 报告明确写出成功、失败、阻塞和外部未验证项。

达到这些条件后，面试中可以准确表述为：

> 我没有只展示一张能生成卡片的 Demo，而是定义了冻结评估集，把结构协议、关键词选择、来源支撑、解释质量和实时延迟拆开测量，并保留逐样本错误标签和 replay 记录。后续再用同一套契约比较基座模型、SFT、DPO 和不同量化版本。
