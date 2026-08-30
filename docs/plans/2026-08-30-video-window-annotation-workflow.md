# CueMind 按视频切分与窗口级标注流程

**目标：** 将本地视频转录切分为可追溯的会议窗口，按完整视频划分数据集，并人工标注卡片触发、关键词和解释内容，为 SFT/DPO 提供无泄漏训练数据。

**输入：**

- 视频：`/home/work/asr/CueMind/dataset/`
- CUDA Whisper 转录：`/home/work/asr/CueMind/reports/video-reimport-20260830-cuda-zh/transcripts/`
- 当前窗口 bundle：`/home/work/asr/CueMind/reports/finetune/local-video-v2/`

当前数据包含 15 个视频、950 个 30 秒窗口。窗口仍为 `unlabeled`，不能直接训练。

## 1. 按视频划分

同一个视频的所有窗口必须属于同一集合，禁止随机按窗口切分。

初始建议：

```text
训练集：10 个视频
验证集：3 个视频
冻结集：2 个视频
```

创建文件：

```text
reports/finetune/video-splits.json
```

示例：

```json
{
  "train": ["37544067530-1-192", "37726521437-1-192"],
  "eval": ["39712261369-1-192", "41105034468-1-192"],
  "freeze": ["39256460576-1-192", "39884555957-1-192"]
}
```

冻结集只用于最终比较，永不参与训练、Prompt 调整或 DPO 构造。

## 2. 窗口数据

每个窗口对应 `sft.jsonl` 的一行：

```json
{
  "id": "稳定窗口 ID",
  "input": "窗口转录文本",
  "sourceFile": "视频文件名",
  "label": null,
  "split": "unlabeled"
}
```

窗口 ID 必须由数据集版本、视频文件、起止时间稳定计算；重建数据时不能因行号变化而改变。

## 3. 标注卡片触发

使用以下标签：

```text
show
skip
duplicate
already_known
not_actionable
insufficient_evidence
```

参会者默认具备该领域的基本知识，因此 `show` 不是术语检测，也不是百科解释触发器。

`show` 条件：

- 当前讨论出现会影响决策的新信息、关键数字、风险或约束；
- 出现争议、异常用法、重要取舍，外部证据能帮助判断；
- 信息具有明确的当前行动价值，且值得打断正在进行的访谈。

以下情况通常不应 `show`：

- 通用领域常识、教科书式定义或参会者大概率已知的术语；
- 仅因为首次出现名词，但无法说明其对当前讨论的具体影响；
- 重复主题、已解释内容、寒暄或没有行动价值的内容。

10 分钟访谈以 3–5 张实际展示卡片作为密度参考，但不是生成配额；允许少于该数量。连续重复主题应抑制，重要决策信息可以突破时间间隔。

示例：

```json
{
  "windowId": "window-001",
  "videoId": "37544067530-1-192",
  "split": "train",
  "trigger": "show",
"triggerReason": "正在比较推理方案，KV cache 的显存取舍会影响当前决策",
  "evidence": "窗口原文第 1–2 句",
  "annotator": "user"
}
```

## 4. 标注关键词

只为确认 `show` 的窗口标注关键词。第一轮只填写一个主关键词：

```json
{
  "windowId": "window-001",
  "keyword": "KV cache",
  "aliases": ["KV 缓存", "键值缓存"],
  "normalizedKeyword": "kv cache",
  "keywordValid": true
}
```

关键词必须能独立检索，不能使用“这个问题”“相关技术”等泛词；少于 2 个字符的词通常无效。`normalizedKeyword` 用于检索和缓存，不替代原始关键词。

## 5. 标注解释内容

只为有效 `show` 窗口标注：

```json
{
  "windowId": "window-001",
  "keyword": "KV cache",
  "keyPoints": ["复用已经计算的键和值", "减少长序列生成时的重复计算"],
  "whyNow": "当前会议正在比较推理延迟和显存占用",
  "evidence": ["窗口明确讨论 KV cache 对推理性能的影响"],
  "answerable": true,
  "annotator": "user"
}
```

`keyPoints` 保持 1–3 条；`whyNow` 必须解释此刻为什么值得弹卡片。没有可靠证据时使用：

```json
{"answerable": false, "keyPoints": [], "whyNow": null}
```

禁止把视频外部常识直接写进解释。解释应优先回答“它对当前讨论有什么具体影响、为什么现在需要注意”，而不是解释通用定义。

## 6. 文件组织

```text
reports/finetune/local-video-v2/
├── manifest.json
├── sft.jsonl
└── dialogsum.jsonl

reports/finetune/annotations/
├── trigger-labels.jsonl
├── keyword-labels.jsonl
└── explanation-labels.jsonl
```

三类标注文件都必须包含 `windowId`、`videoId`、`split`、`annotator`；解释标注还必须包含 evidence。DPO 的 `chosen/rejected` 只能来自人工确认，不得直接使用自动模型输出。

## 7. 标注顺序与质量检查

第一轮标注 300–500 个窗口，优先覆盖明显 show、明显 skip、重复概念、无证据、中英文混合和长短不同窗口。建议先完成：

```text
trigger → keyword → keyPoints/whyNow → DPO 偏好
```

提交训练前检查：

- 同一视频未出现在多个 split；
- 冻结集未进入训练或 Prompt 调整；
- 每个 show 窗口有关键词或明确无效原因；
- 每个解释样本有 evidence 或正确拒答标记；
- 无重复 windowId；
- 无音频、密钥、Trace 或原始敏感字段进入训练文件；
- Schema、JSONL、来源和标注人字段完整。
