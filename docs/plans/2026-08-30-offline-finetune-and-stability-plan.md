# CueMind 工程稳定性与微调实验计划

**目标：** 在不破坏本地实时会议链路的前提下，先建立可重复的稳定性基线，再用两个公开数据集补充 CueMind 专属数据，完成卡片触发、关键词和解释内容的 SFT/DPO 实验。

**数据选择：**

- [AMI Meeting Corpus](https://huggingface.co/datasets/knkarthick/AMI)：会议转录、主题和摘要，CC BY 4.0。用于构造会议窗口和 `show/skip` 候选，不直接视为 CueMind 真值。
- [DialogSum](https://huggingface.co/datasets/knkarthick/dialogsum)：对话、主题和摘要，CC BY-NC-SA 4.0。仅用于补充解释表达和关键词格式，发布前必须保留署名并遵守非商业条款。

公开数据占训练数据不超过 40%；CueMind 真实转录、卡片、失败轨迹和人工裁决占至少 60%。冻结集按会议/视频划分，永不进入训练。

## 阶段 0：稳定性基线

**目标：** 先证明不微调时系统可重复，避免把工程问题误判为模型问题。

1. 固定 `datasetVersion`、视频哈希、窗口版本、模型哈希、Prompt 版本、搜索策略版本和 `cacheKey` 规则。
2. 对 `partial/confirmed` 做时序检查：partial 只展示，卡片只消费 confirmed；confirmed 不回退、不重复。
3. 明确终态：`card_shown`、`model_skip`、`invalid_schema`、`search_failed`、`timeout`、`model_failed`，禁止失败伪装成正常卡片。
4. 对同一视频执行冷启动、热启动、重复重放、断流、重启和无音频路径。
5. 每次保存完整 Trace：ASR、触发判断、关键词、检索、生成、缓存、错误和恢复时间。

**门禁：** 同输入候选 ID 和 cacheKey 稳定；Schema 失败可解释；confirmed 无回退/重复；冷/热缓存统计口径一致；所有失败有终态。

## 阶段 1：CueMind 数据构建

**目标：** 建立第一版业务训练集，不直接依赖公开数据的自动标签。

1. 从 `/home/work/asr/CueMind/dataset/` 的视频转录生成 8–30 秒窗口，并保存视频哈希、时间范围、转录片段 ID。
2. 人工标注 `trigger`：`show`、`skip`、`duplicate`、`already_known`、`not_actionable`、`insufficient_evidence`。
3. 对 `show` 样本标注一个主关键词、可选 aliases 和关键词规范化形式。
4. 对有证据的卡片标注 `keyPoints`、`whyNow`；无可靠证据标注正确拒答。
5. 按视频/会议划分 `train/eval/freeze`，禁止相邻窗口跨集合泄漏。
6. 运行去重、脱敏、Schema 校验和样本来源审计；导出 SFT JSONL 与 DPO JSONL。

**首轮规模：** 300–500 条 trigger 样本、100–300 条关键词样本、100–300 条解释偏好对。数量不足时延后训练，不用自动标签填充。

## 阶段 2：AMI 窗口触发 SFT

1. 将 AMI 的会议转录按 CueMind 窗口规则切分。
2. 使用主题、摘要和对话行为生成“候选重要窗口”，再由人工抽样校正 `show/skip`。
3. 训练输入只包含窗口和已知关键词；输出只包含 `trigger` 与简短 `reason`。
4. 使用 QLoRA 4-bit，冻结基础模型；固定 seed、学习率、epoch、最大长度和 adapter 配置。
5. 先在 CueMind freeze 集评估，再在真实视频影子运行；不修改线上 Prompt 和基础模型。

**指标：** show precision/recall、误触发率、漏报率、重复卡片率、Schema 有效率、单窗口延迟。触发模型不得降低 confirmed 一致性、缓存命中率或服务恢复能力。

## 阶段 3：关键词 SFT

1. 只使用人工确认的 `show` 窗口和 AMI 主题/摘要中可验证的术语。
2. 第一轮只输出一个主关键词；第二轮再加入 aliases。
3. 对每个窗口重复推理 3 次，记录原始关键词、规范化关键词和最终 cacheKey。
4. 评估规范化完全匹配、同义词命中率、重复运行一致率、检索命中率和 cacheKey 一致率。
5. 关键词模型与 trigger 模型分开 adapter，避免一个任务的回归掩盖另一个任务的问题。

## 阶段 4：解释 SFT 与 DPO

1. 用 CueMind 人工解释作为主数据，DialogSum 仅补充摘要表达和简洁格式。
2. 输入固定为窗口、关键词和检索证据；输出 `keyPoints`、`whyNow`，没有证据时输出拒答。
3. QLoRA-SFT 先学习格式、事实约束和上下文相关性。
4. 对同一输入构造 chosen/rejected：chosen 必须有证据且简洁；rejected 为泛化、编造、冗余或答非所问文本。
5. 在 SFT 模型基础上执行 DPO；偏好对必须人工确认，合成偏好只能作为候选并抽样审计。
6. 比较 base、SFT、DPO 三组的事实一致性、证据覆盖率、相关性、冗余率、正确拒答率、JSON 有效率和人工偏好胜率。

## 阶段 5：受控发布

每个 adapter 绑定基础模型哈希、数据集版本、训练配置、代码提交、Prompt/Schema 版本和 freeze 报告。执行影子运行后由人工选择保留、灰度或回滚；禁止线上自动换模、自动改 Prompt 或自动改权重。

**推荐顺序：**

```text
工程基线 → CueMind trigger SFT → AMI 补充 → CueMind keyword SFT
→ DialogSum/真实数据解释 SFT → 解释 DPO → 影子运行 → 人工发布
```

**不做的事项：** 不微调 Whisper；不使用公开数据直接生成业务真值；不把摘要质量当作卡片触发质量；不以平均延迟替代 P95、失败率和恢复指标。
