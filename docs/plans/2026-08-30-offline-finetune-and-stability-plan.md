# CueMind 工程稳定性与微调实验计划

**状态：阶段 0–1 已实现；阶段 2–5 依赖代码已就绪，真实训练与公开数据下载按需执行。**
**目标：** 先建立不微调的可重复基线，再使用 AMI 和 DialogSum 补充训练，单独验证卡片触发、关键词提取和解释内容，最终通过影子运行和人工决策发布。

**数据与约束：** AMI Meeting Corpus（CC BY 4.0）用于会议窗口和重点候选；DialogSum（CC BY-NC-SA 4.0）仅用于解释表达补充。公开数据不超过训练数据 40%，CueMind 真实转录、卡片、失败轨迹和人工裁决不少于 60%；冻结集按视频/会议划分且永不训练。

### 阶段 0：工程稳定性基线

**状态：待执行。**
**目标：** 证明不微调时系统可重复，避免将工程故障误判为模型能力。
**范围：** 固定数据、窗口、模型、Prompt、搜索策略和 `cacheKey`；验证 partial/confirmed、终态、冷/热缓存、重复重放、断流、重启和无音频路径；保存 ASR、触发、关键词、检索、生成、缓存和恢复 Trace。
**异常矩阵归属：** Schema 失败、超时、搜索失败、模型失败、缓存写入失败、confirmed 回退/重复、断流和服务重启。
**测评依据：** 阶段 7–8 冻结视频、`scripts/run-offline-eval.sh`、ASR/重放/治理回归脚本。
**验收：** 候选 ID 和 cacheKey 稳定；失败均有明确终态；confirmed 无回退/重复；缓存统计口径一致；报告保留完整分母。阶段 0 已由现有治理、ASR、重放和离线评测脚本覆盖。

### 阶段 1：CueMind 训练数据构建

**状态：待执行。**
**目标：** 形成以真实人工裁决为主的 SFT/DPO 数据。
**范围：** 视频转录切分 8–30 秒窗口；以参会者具备基础领域知识为前提，标注 `show/skip/duplicate/already_known/not_actionable/insufficient_evidence`；为 show 样本标注主关键词、aliases、`keyPoints`、`whyNow` 和正确拒答；去重、脱敏、Schema 校验并按视频划分 train/eval/freeze。通用领域常识和仅因术语首次出现的窗口默认不出卡。
**异常矩阵归属：** 空窗口、坏转录、重复样本、泄漏样本、未确认自动标签和敏感字段外泄。
**测评依据：** `scripts/export-training-data.ts`、人工裁决文件、数据 manifest。
**验收：** 首轮至少 300–500 条 trigger、100–300 条关键词、100–300 条解释偏好对；每条样本具备来源、标注人和证据。当前 6 个本地视频已生成 372 个未标注窗口，公开数据下载暂按用户决定跳过，必须完成人工标注后才能进入训练。

**2026-08-30 执行记录：** 本地视频集已扩展至 15 个视频；CUDA Whisper 完成新增 9 个视频转录，阶段 1 bundle `reports/finetune/local-video-v2` 共生成 950 个 30 秒窗口。窗口仍为 `unlabeled`，下一步是按视频划分并进行人工 `show/skip`、关键词和解释标注。

**2026-08-31 人工确认记录：** 用户确认 `reports/finetune/annotations-v2/error-analysis/` 下 5 份 v2 文件全部为人工确认记录。新增 `scripts/merge-confirmed-error-analysis.ts` 只读重建转录窗口并导出至本地 `confirmed-error-analysis` 目录：59 条 trigger、27 条 keyword、40 条 explanation、40 条 DPO preference；166 条记录仅含 `train/eval`，`freezeExcluded=0`，并通过窗口 ID、videoId、重复项校验。原始输入和标注文件保持不变，导出数据不纳入 Git。

### 阶段 2：卡片出现时机 SFT

**状态：待执行。**
**目标：** 学习窗口是否值得打断访谈并生成卡片，优先控制通用常识卡和重复卡的误触发。
**范围：** AMI 转 CueMind 窗口并人工校正候选；QLoRA 4-bit 仅输出 `trigger` 和 `reason`；将“决策影响、风险、约束、关键数字、争议和异常”作为正例重点，将“已知常识、普通术语和无行动价值”作为 hard negative；CueMind freeze 集先评估，再影子运行。
**异常矩阵归属：** 误触发、漏报、重复卡片、Schema 失败、partial 误触发和延迟回归。
**测评依据：** show precision/recall、误触发率、漏报率、重复率、JSON 有效率、单窗口延迟。
**验收：** 不降低 confirmed 一致性、缓存命中率、服务恢复能力和正常回答延迟；未达标则不进入下一阶段。

### 阶段 3：关键词 SFT

**状态：待执行。**
**目标：** 让主关键词、别名和 cacheKey 稳定。
**范围：** 只用人工确认的 show 窗口；第一轮只输出一个主关键词，第二轮加入 aliases；trigger 与 keyword 使用独立 adapter；每窗口重复推理 3 次。
**异常矩阵归属：** 关键词漂移、过短/过泛、同义词不一致、检索未命中和 cacheKey miss。
**测评依据：** 规范化完全匹配、同义词命中率、重复一致率、检索命中率、cacheKey 一致率。
**验收：** 关键词一致性和检索命中改善，且不增加 Schema 失败、延迟或误触发。

### 阶段 4：解释 SFT 与 DPO

**状态：待执行。**
**目标：** 生成基于证据、简洁且与当前决策相关的卡片解释，而不是重复领域常识。
**范围：** CueMind 人工解释为主，DialogSum 仅补充表达；输入固定为窗口、关键词和证据；先 QLoRA-SFT 学 `keyPoints/whyNow` 和拒答，再用人工确认 chosen/rejected 做 DPO。`chosen` 应突出具体影响和当前价值，`rejected` 应覆盖百科式定义、泛泛背景、重复信息和无证据扩写。
**异常矩阵归属：** 编造事实、无证据回答、冗余、答非所问、拒答错误、JSON 失败和检索/生成归因混淆。
**测评依据：** 事实一致性、证据覆盖率、上下文相关性、关键点完整性、冗余率、正确拒答率、JSON 有效率和人工偏好胜率。
**验收：** DPO 相对 base/SFT 有冻结集证据改善，且不降低延迟、Schema、缓存和 ASR 链路指标。

### 阶段 5：影子运行与人工发布

**状态：待执行。**
**目标：** 在不影响线上模型的前提下验证 adapter，并形成可回滚发布决定。
**范围：** 每个 adapter 绑定基础模型哈希、数据集版本、训练配置、代码提交、Prompt/Schema 版本和 freeze 报告；影子运行后由人工选择保留、灰度或回滚。
**异常矩阵归属：** 模型加载失败、OOM、超时、质量回退、影子偏差、发布中断和回滚失败。
**测评依据：** `lib/model-release.ts`、模型基线 manifest、阶段 8 重放 Trace 和冻结集对照报告。
**验收：** 无线上自动换模、自动改 Prompt 或自动改权重；发布、回滚和责任人均有审计记录。

**执行顺序：** `工程基线 → CueMind trigger SFT → AMI 补充 → keyword SFT → DialogSum/真实数据解释 SFT → 解释 DPO → 影子运行 → 人工发布`。
