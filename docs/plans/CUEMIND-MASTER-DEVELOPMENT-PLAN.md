# CueMind Master Development Plan

> **唯一开发入口（Single Source of Truth）**
>
> 后续 CueMind 的开发、排期、阶段状态、验收证据、遗留问题和新增决策影响，统一追加到本文档。开始任何代码工作前，先读取本文档的“当前执行阶段”；不要直接从旧路线图或 handoff 推断下一步。

**项目定位：** 本地优先的实时会议认知副驾，面向稳定的 10 分钟演示、可解释指标和可审计工程取舍。

**当前日期：** 2026-08-30
**仓库：** `/home/work/asr/CueMind`
**分支：** `codex/local-realtime-meeting-copilot`

## 1. 文档权威关系

本文档不覆盖产品决策，只整合执行顺序和实现状态。

| 层级 | 文档 | 权限 | 用途 |
|---|---|---|---|
| 1 | `docs/product/cuemind-grilling-decisions.md` | 最高 | 68 道产品决策、红线和变更历史；只追加，不覆盖 |
| 2 | `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md` | 当前开发入口 | 阶段顺序、依赖、文件范围、验收和后续追加记录 |
| 3 | `docs/plans/2026-08-29-cuemind-optimization-roadmap.md` | 历史整改依据 | P0-P5 问题来源和原始分析；状态以本文档为准 |
| 4 | `handoff.md` | 接手导航 | 项目速览、环境和本文档入口；不替代开发计划 |
| 5 | `CLAUDE.md` | 工程规范 | 命令、架构约束、运行环境和代码纪律 |
| 6 | `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md` | 测评执行依据 | 测评输入、命令、指标口径、证据边界、异常矩阵和发布证据；负责“怎么测” |

如本文档与决策文档冲突，以决策文档为准；如本文档与旧路线图状态冲突，以本文档最近一次带证据的记录为准。

## 2. 当前执行阶段

**当前阶段：阶段 1，P0 延迟稳定性收口。**

当前不要并行开发 P2、训练、ASR 2.1b 或新的模型接入。阶段 1 完成后，才能进入阶段 2。

### 当前已确认事实

- 模型：Qwen3-8B-Q4_K_M，llama.cpp，RTX 4060 Ti 8GB，完整 GPU offload。
- 当前运行服务：`cuemind-llama.service`，`127.0.0.1:8082`。
- `-np 1` 冻结题集单轮结果：8/8 成功，完成 P50 `5888ms`，P95 `6778ms`，通过 7 秒预算。
- 原 4-slot 对照：完成 P50 `7295ms`，P95 `9626ms`。
- `-np 1` 后首事件 P95 `1718ms`，仍通过 3 秒预算。
- `-np 1` 连续 `8 题 × 3 轮` 均为 `8/8` 成功；完成 P95 分别为 `5859ms`、`3738ms`、`3861ms`，首事件 P95 分别为 `938ms`、`707ms`、`754ms`。
- 第 2、3 轮搜索全部命中缓存，属于热缓存稳定性证据；不能替代冷缓存或扩展题集的生产级 P95 证据。
- KV cache `q8_0` 对照无实质收益：生成均值 `2881ms`，仅比控制组 `2931ms` 快约 1.7%；不采用。
- Qwen3-8B EAGLE3 尚未验证：外部模型下载不稳定，未生成 GGUF，不能声称可用或不可用。
- 当前服务运行配置已使用 `-np 1`，且 `:8082` health 为 OK、`:3000` 返回 200。
- 仍存在配置漂移：仓库 fallback 单元中的模型路径还是旧 4B 路径，实际 systemd 单元使用 8B；需在阶段 1 一并处理。

### 阶段 1 尚未完成的事项

- 冻结集 `8 题 × 3 轮` 已完成，但后两轮为热缓存；已建立基于 `dataset/` 视频内容的 38 题扩展题集。
- 已完成一次冷/热标记分层实测；热标记与实际搜索缓存命中存在 17 次不一致，服务重启/显存压力真实性能矩阵仍未完成。
- 扩展题集不声明授权状态，题目带视频文件与时间定位元数据；不得复制冻结 8 题扩展。
- 38 题扩展集尚未完成“视频内容抽取/转录 → 实际卡片 → 卡片驱动询问”的完整 lineage，不得将其称为完整视频问答证据。
- 尚未把 `-np 1` 的结果追加到决策 67 和优化路线图。
- 尚未执行本阶段变更后的完整门禁。

## 3. 产品与工程不变红线

以下内容在任何阶段都不得被性能或功能目标绕过：

1. **实时链路零侵入：** 询问、导出、训练和 MCP 不得阻塞或改变 ASR/卡片链路；卡片 P95 约束不因 Live Ask 放宽。
2. **外发最小化：** 搜索只允许外发问题和提取关键词，不发送会议转写；当前关键词提取失败时外发问题前 20 字是已记录但必须根治的例外。
3. **不编造：** 来源少于 2 条、来源冲突、schema 违规、模型失败或超时必须降级/失败闭合，不以流畅文本代替证据。
4. **纯离线训练导出：** 导出只读数据库，不写库、不联网、不包含音频、密钥或原始敏感字段；永不 `git add dataset/`。
5. **人工裁决优先：** 自动信号只能产生候选，未经用户确认不得直接进入 DPO 或改变线上策略。
6. **决策历史追加式维护：** 不修改既有 68 道决策正文；语义变化只追加变更记录。
7. **证据边界诚实：** mock、fixture、SSR 替代验证和 n=8 小样本必须明确标识，不能包装成真实生产证据。

## 4. 总体执行顺序

```text
阶段 0 环境与版本锁定
        ↓
阶段 1 P0 延迟稳定性收口
        ↓
阶段 2 P2 询问持久化与数据契约
        ↓
阶段 3 P5 隐私降级口根治
        ↓
阶段 4 P4 用户裁决与失败可见
        ↓
阶段 5 P3 训练信号严谨化
        ↓
阶段 6 P5 工程卫生与端到端证据
        ↓
阶段 7 长期能力：ASR 2.1b、知识治理、模型替换评估
```

每次只推进一个阶段。阶段之间不得以“顺手”方式插入未登记的功能；发现路线图未覆盖的产品语义，先停下来追加决策问题并等待确认。

## 5. 阶段计划

### 阶段 0：环境与版本锁定

**状态：已具备，作为每次开发前置检查。**

**目标：** 确保开发会话使用正确仓库、正确模型、正确服务和可复现数据。

**开始前检查：**

```bash
cd /home/work/asr/CueMind
git log -1 --oneline
git status --short
curl -fsS http://127.0.0.1:8082/health
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

**必须确认：**

- 不在 `/home/work/asr` 根目录执行 git；
- 不打印 `.env` 内容；
- 不触碰 `dataset/`、模型目录和报告目录中的用户产物；
- 服务由 systemd 管理，不能手动杀 llama-server；
- build 前必须停止 `:3000` dev server。

### 阶段 1：P0 延迟稳定性收口

**状态：进行中。**
**来源：** 决策 67；旧路线图 P0。
**目标：** 在不牺牲引用式回答、来源约束和实时链路的前提下，证明 `-np 1` 的完成 P95 稳定满足 `≤7000ms`。

**文件边界：**

- 修改：`scripts/cuemind-llama.service`；必要时修改部署说明和本文档；
- 验证：`scripts/measure-ask-latency.ts`；
- 记录：`docs/product/cuemind-grilling-decisions.md` 只追加变更记录；
- 不修改：`app/api/ask/route.ts`、实时 ASR、卡片触发和来源规则。

**执行步骤：**

1. 以当前 8B、`-np 1` 配置连续复跑冻结 8 题至少 3 轮。
2. 每轮记录 `8/8` 成功率、首事件 P95、完成 P50/P95、keyword/search/generation 分段耗时、schema 违规数和显存。
3. 以不改变冻结题集的方式建立至少 30-50 题扩展题集，覆盖问题长度、主题、关键词提取路径、垂直源命中和通用搜索回退；扩展集只能用于补充稳定性证据，不能替换冻结集。
4. 将扩展题集按冷缓存和热缓存分层运行，分别报告 P50/P95/P99、完整分母和异常终态。
5. 运行阶段 1 性能异常矩阵：关键词提取慢/失败、搜索慢/失败、来源不足、模型超时、schema 违规、服务重启/显存压力；记录首事件、完成时间、终态和是否满足 fail-closed。
6. 若任一正常回答轮次完成 P95 超过 7 秒，保留失败证据，不调整题集或预算，暂停并重新进行产品/推理裁决。
7. 修复仓库 fallback 单元与实际 8B 模型配置的漂移，避免回退到未评估的 4B。
8. 追加决策 67 的 `-np 1` 实测记录，并在旧路线图中回写状态；不覆盖 2026-08-29 记录。
9. 通过完整门禁后，才将 P0 标记为“已关闭（证据范围：冻结集、扩展集与当前硬件）”。

**测评依据：** `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md` 的 Live Ask 延迟、扩展题集、冷/热缓存和统一异常矩阵章节。扩展题集属于阶段 1；当前仅有冻结 8 题脚本和既有报告，未发现获授权的 30-50 题数据，不能将其结果写成已完成。

**验收：**

- 连续复测全部 `8/8`；
- 完成 P95 `≤7000ms`；
- 首事件 P95 `≤3000ms`；
- schema 违规为 0；
- 来源不足仍严格降级；
- 卡片并发回归无退化；
- 扩展题集冷/热缓存结果均有完整分母，且正常回答 P95 不超过 7 秒；
- 阶段 1 性能异常矩阵的终态、延迟和 fail-closed 结果可复现；
- systemd health OK，应用 `:3000` 返回 200。

**不在本阶段做：** EAGLE3 下载转换、SGLang/vLLM 迁移、降低回答质量、单引用改造、主动问题检测；扩展题集不用于调参或改写预算。

### 阶段 2：P2 询问持久化与数据契约

**状态：已完成。**
**来源：** 决策 56、65、67；旧路线图 P2。
**目标：** 让询问历史在刷新、replay、vault 导出和训练数据导出中保留真实来源、关键词和终态。

**实现边界：**

- `lib/chat-store.ts`：增加 `sources_json`、`keywords_json`、`final_state`；旧库通过 `PRAGMA table_info` 检测后只 `ALTER TABLE ADD COLUMN`；
- `app/page.tsx`：保存询问的 sources/keywords/finalState；
- `app/api/chat-messages/route.ts`：解析和校验新字段；
- `app/replay/page.tsx`：渲染询问历史、来源链接和降级标识；
- `scripts/export-training-data.ts`：使用真实关键词，不再以问题原文代理；
- `scripts/test-chat-store.ts`、`scripts/test-export-training-data.ts` 及 replay 测试：覆盖新库、旧库、重复启动和非法 JSON。

**验收：**

- 刷新后 sources、keywords、终态可恢复；
- replay 显示询问历史和来源；
- 旧数据库升级幂等；
- 训练导出读真实提取关键词；
- 持久化失败不阻塞实时链路；
- 不改变现有卡片 P95 和 SSE 语义。

**2026-08-30 完成记录：** `ChatMessage`/`StoredChatMessage` 增加 `sources`、`keywords`、`finalState`；SQLite 通过 `PRAGMA table_info` 幂等追加三列，JSONL 兼容解析；`/api/chat-messages`、首页保存/恢复和 replay sessionId 加载展示均已接入。SQLite/JSONL chat-store、训练导出、ask 回归和 TypeScript 门禁通过；持久化请求继续采用 fire-and-forget，失败不阻塞实时链路。

### 阶段 3：P5 隐私降级口根治

**状态：已完成。**
**来源：** 决策 33、67；旧路线图 U5/P5。
**目标：** 消除关键词提取失败时外发问题前 20 字的例外，使“外发仅关键词”成为实际行为而不只是文档声明。

**预期行为：**

- 关键词提取失败时不发起联网搜索；
- 本地询问终态明确为“未提取到可搜索关键词”的降级状态；
- 不伪造来源，不把问题原文送入搜索；
- UI 和 trace 能区分提取失败、来源不足和模型失败。

**验收：**

- `test-ask-route.ts` 断言提取失败时零外发；
- 外发请求体只含已提取关键词和允许的问题字段；
- 降级信息进入本地历史但不进入总结、vault 或训练正负样本；
- 真实请求日志不得出现转写正文。

**异常矩阵归属：** 本阶段只验证隐私边界和外发请求体；性能异常留在阶段 1，跨模块数据一致性留在阶段 6。关键词提取失败必须验证为零搜索、零转写外发，并保留本地可见降级终态。

**测评依据：** 测评实现手册“统一异常矩阵与阶段归属”中的隐私异常章节。

**2026-08-30 完成记录：** `/api/ask` 在无 `termHint` 且关键词提取失败时直接返回本地 `degraded`，不执行搜索或生成；`termHint` 仅作为用户明确提供的受控关键词回退。新增 ask 回归用例验证零搜索外发；`tsc` 与 ask 回归通过。

### 阶段 4：P4 用户裁决与失败可见

**状态：已完成。**
**依赖：** 阶段 2。
**来源：** 决策 6、65；旧路线图 P4/U3/U7。
**目标：** 修复自动询问信号绕过人工把关的问题，并让用户看到询问系统的失败模式。

**实现边界：**

- 卡片侧增加“该词应出卡”的本地裁决入口；
- 裁决写入现有本地审计/候选存储，不写云端；
- 自动询问命中只生成候选提示；
- 只有用户确认的漏报才进入 DPO；
- 设置健康区展示降级率、来源不足率、近 20 次完成延迟；
- 失败率按固定终态统计，不能把失败文案当答案。

**验收：**

- 确认漏报后离线导出可识别；
- 未确认自动命中不进入 DPO；
- 统计字段刷新后仍可解释；
- 决策 65 追加记录“人工确认后才进入训练”；
- 训练导出和线上实时链路无写入阻塞。

**2026-08-30 完成记录：** `ContextCardView` 增加本地“标记应出卡”裁决入口并按 candidateId 幂等保存；设置健康区保留失败/降级统计；回归矩阵验证失败终态可见，人工 `--useful` 通道由导出脚本消费。

### 阶段 5：P3 训练信号严谨化

**状态：已完成。**
**依赖：** 阶段 2、阶段 4。
**来源：** 决策 65；旧路线图 P3/U4。
**目标：** 让离线 SFT/DPO 数据反映真实、经过人工裁决的决策轨迹。

**必须实现：**

- 读取候选和询问的 `created_at`，只统计问题时间不早于候选时间的命中；
- `--useful` 人工通道优先，询问命中不能重复生成同一 DPO 对；
- trim 后长度小于 2 的 term 不做子串命中；
- 报告分开统计候选来源、人工确认数、自动候选数和最终 DPO 行数；
- 保留按 session 切分和字节级幂等。

**验收：**

- 出卡前提问不计入漏报；
- 同一候选双通道不重复造 DPO；
- 短 term 不误匹配；
- 导出过程只读，重复导出字节一致；
- 训练数据不含密钥、音频和未确认的自动信号。

**2026-08-30 完成记录：** 导出按候选 `created_at` 构造时间窗口；人工 `--useful` 优先于询问命中，避免重复 DPO；term 长度小于 2 不做子串命中；SFT/DPO 切分与字节级幂等回归通过。

### 阶段 6：P5 工程卫生与端到端证据

**状态：已完成（当前仓库范围）。**
**目标：** 将当前可用但有局部隐含风险的系统，收敛为可交接、可回归、可发布的面试项目。

**范围：**

- 询问落库最多 3 次指数退避，最终失败本地可见；
- replay 含询问历史的端到端测试；
- summarize 前端传参链路端到端测试；
- 清理 `lib/partial-transcript.ts` 的历史 lint warning；
- 处理 `AGENTS.md`、部署文档和工作区改动的归属；
- `dataset/` 永不跟踪；
- 统一 4B/8B 服务说明、sha256、启动参数和回退说明；
- 所有报告标注真实、mock、fixture 和替代验证边界。

**异常矩阵归属：** 本阶段执行端到端异常矩阵，包括落库失败重试与最终可见、刷新/replay 缺字段、总结/ vault 过滤、训练导出过滤、服务恢复和历史数据兼容；不得用路由单测替代跨模块证据。

**测评依据：** 测评实现手册的 SQLite/replay、vault、训练数据、MCP 和统一发布章节。

**验收：**

- `npm run lint` 无 warning；
- 回归矩阵全绿；
- 服务重启后 health OK；
- `git status` 中只保留明确的用户产物，不出现意外密钥或数据集。

**2026-08-30 完成记录：** 询问落库采用最多 3 次指数退避且最终错误进入本地状态；replay、summarize、vault、训练导出、服务恢复和历史兼容回归均通过；`lib/partial-transcript.ts` lint warning 已清零；`npm run lint`、`npx tsc --noEmit`、`npm run build` 均通过，服务恢复后 health/app probe 正常。Next 构建仍提示动态 `createRequire` 的既有 bundler warning，不影响产物生成，列为后续工程清理项。

### 阶段 7：长期能力路线

**状态：基础实现已完成，真实模型实验与硬件证据待执行；不阻塞阶段 1-6。**

**目标：** 在完全离线、本地可审计和可回滚的约束下，补齐知识治理、ASR 可靠性、训练数据治理、模型评估和本地交接能力。

**范围：**

- Vault 作为唯一写入源，MCP 只读消费；版本、来源、冲突和人工裁决可审计；
- 常驻 Whisper、LocalAgreement-2 和 confirmed 水位一致性；
- SFT/DPO 训练数据治理、候选模型评估和影子运行；
- 固定冻结集、硬件、模型哈希和运行时版本的性能基线；
- Docker、本地 Trace、断网验证、人工发布和回滚。

**异常矩阵归属：** 本阶段覆盖治理写入失败/重复写入/冲突待审/撤回过滤、MCP 只读和历史版本、ASR 断流/重启/超时/资源压力、训练导出污染、候选模型回滚、Docker 启停升级失败和断网运行；不得以单一模型样例替代跨模块证据。

**测评依据：** [知识治理与 MCP 计划](2026-08-27-cuemind-knowledge-export-mcp-plan.md)、[工程稳定性与微调实验计划](2026-08-30-offline-finetune-and-stability-plan.md)、冻结视频重放、ASR 可靠性、模型基线和 Docker 交接脚本。

**阶段 7.1–7.8：**

- **7.1–7.4 知识治理：** Vault 追加版本、来源等级、冲突待审、高风险审批、撤回和审计；MCP 仅提供关键词、当前版本和历史版本读取。
- **7.5–7.6 训练数据与候选模型：** CueMind 人工裁决数据主导，公开数据仅补充；按 `trigger-sft.jsonl`、`keyword-sft.jsonl`、`explanation-sft.jsonl`、`explanation-dpo.jsonl` 依次执行离线训练；训练仅用 `train`，仅在 `eval` 集评估，`freeze` 集保持隔离，完成冻结集一次性对比和影子运行后由人工决定发布或回滚。

- **训练数据规模口径：** 目标为 15–30 个本地视频加受控公开数据。CueMind 数据至少占混合训练集 60%，AMI 用于会议窗口/触发补充，DialogSum 仅用于解释表达，公开数据最多占 40%，且不得进入 freeze。推荐顺序为：保留现有 15 个视频 → CueMind trigger 补至至少 500 条 → 加入 AMI 1,000–1,500 条 → 加入 DialogSum 约 1,000 条 → 以人工偏好为主补齐 DPO 300–500 对；只有 explanation/DPO 仍不足时才扩展到 30 个视频。
- **7.7 ASR 可靠性：** confirmed 不回退/不重复，断流和重启可恢复，记录吞吐、确认延迟、错误率和恢复时间。
- **7.8 模型基线与一键交接：** 固定 4B/8B、量化、KV cache、GPU 参数，提供本地 Trace、Docker 和一键评测/回滚流程。

**验收：**

- `npm run lint`、`npx tsc --noEmit`、`npm run build` 及阶段 7 回归脚本通过；
- 治理、ASR、训练导出、模型发布和 Docker 脚本的 fixture 可重复；
- 真实冻结视频上的候选模型影子运行报告完整，包含质量、吞吐、显存、首 token、P95、失败样本和恢复时间；
- 断网环境可完成核心重放与本地报告生成，人工确认后才允许版本化发布或回滚。

**实现记录：** 7.1–7.8 的基础代码与回归脚本已完成；真实模型矩阵、长时间压力、影子运行和隔离主机断网演练仍需补充硬件证据。

**阶段 0–1 实现记录：** `scripts/build-finetune-dataset.ts` 已基于 6 个本地视频转录生成 372 个 30 秒窗口、稳定样本 ID、manifest 和 SFT JSONL；`lib/finetune-dataset.ts` 提供转录/对话样本规范化，`lib/finetune-experiments.ts` 提供阶段 2–5 的 trigger/keyword/explanation Prompt 和基础指标。AMI/DialogSum 下载按当前决定跳过，样本保持 `unlabeled`，不得直接训练。

**视频扩展记录：** `scripts/transcribe-videos.ts` 支持 CUDA Whisper 断点续跑；新增 9 个视频已完成转录，累计 15 个视频、950 个 30 秒窗口，bundle 位于 `reports/finetune/local-video-v2`。数据仍需人工标注后才能训练。

**2026-08-31 人工确认增量：** 用户确认 error-analysis v2 五份标注文件全部可用于训练。`scripts/merge-confirmed-error-analysis.ts` 已完成只读校验与导出，产生 59 条 trigger、27 条 keyword、40 条 explanation 和 40 条 DPO preference；仅接受 `train/eval`，拒绝 `freeze`，并验证窗口 ID、videoId 与重复项。原始 `annotations/`、`annotations-v2/` 和输入转录保持不变，导出目录属于本地报告，不提交 Git。

### 阶段 8：实时稳定性与本地可观测性

**状态：基础重放与 Trace 已完成，长时间压力和真实硬件观测待执行。**
**目标：** 用本地视频重放模拟实时会议，证明系统在暂停、断流、重启和资源压力下可恢复，并生成可比较的本地回归证据。
**范围：** 暂停/继续/重复/断点重放；ASR、LLM、GPU/CPU、显存、等待时间、端到端延迟和错误恢复的本地 Trace；不建设跨机器队列、外部消息队列或多租户资源配额。
**异常矩阵归属：** 重放暂停/取消/重启、断流、超时、磁盘不可写、显存不足、内存增长和服务恢复。
**测评依据：** `lib/realtime-replay.ts`、`scripts/test-realtime-replay.ts`、固定视频重放结果和本地 JSONL Trace。
**验收：** 固定视频可重复回放；长时间运行无未解释内存增长；压力下有降级和恢复证据；同输入配置生成可比较报告。

#### 阶段 8A：检索与缓存韧性测评

**状态：fixture 评测与缓存来源契约已实现，真实网络矩阵待执行。**
**目标：** 证明垂直检索、通用搜索回退、来源不足和超时终态可重复，并修正缓存命中统计口径。
**范围：** 一个垂直源超时但其他源足够、垂直源不足回退、回退不足、全部超时、非法来源、冷缓存、卡片预热命中、询问热命中、TTL 过期、别名/大小写规范化和重复候选抑制。缓存条目区分 `ask` 与 `context_card` 来源。
**实现边界：** 复用 `lib/search.ts` 和 `lib/ask-cache.ts`；新增本地可控 fixture/评测执行器，不依赖外网稳定性。失败终态继续遵守 fail-closed，不生成无来源领域常识卡。
**报告：** `reports/retrieval-resilience/<run-id>/manifest.json`、`cases.jsonl`、`failures.jsonl`、`scorecard.json`、`report.md`；命中分类固定为 `cold_miss`、`card_warmed_hit`、`ask_hot_hit`、`expired_miss`。
**验收：** fixture 已覆盖单源故障、回退、全超时和四类缓存分类，`npx tsx scripts/evaluate-retrieval-resilience.ts fixtures/retrieval-resilience-v1.json <output>` 通过；单源故障不影响足够来源的成功路径；来源不足和全超时有明确终态；缓存统计不把上游卡片预热误报为询问热命中；同一输入的 `cacheKey` 稳定。真实网络/API 限流证据仍待执行。

#### 阶段 8B：会后体验增强

**状态：整理、脱敏、时间线数据层、前端触发和 Vault sidecar 已实现；真实桌面音频播放仍未纳入。**
**目标：** 在不修改原始会议事实的前提下提供整理、脱敏和可回放的时间定位数据。
**范围：** 会后异步 `polishTranscript`（失败回退原文）；确定性规则和用户词典驱动的脱敏导出副本；Markdown/JSON/Vault 保留 `startMs/endMs`；新增 `timeline.json` 关联转写、卡片、询问和总结段落。
**实现边界：** 不实现 Electron 播放器、`cuemind://` 协议或未经验证的音频 URL；时间线首版只提供稳定导出锚点，未来播放器复用该契约。
**隐私与审计：** 原始转写、SQLite、浏览器会话和 Vault 不可覆盖；脱敏附带 `redaction-manifest.json`，不记录原始敏感值并标记人工复核要求。
**验收：** `scripts/test-postmeeting-experience.ts` 和 `scripts/test-vault-exporter.ts` 已通过；会后可通过 `/api/postmeeting-transcript` 和前端“整理转写”按钮生成整理版，失败可回退；导出副本支持 raw/polished 与 redacted 选项；会议笔记自动写入 `<meeting>.md.timeline.json` 与 `<meeting>.md.redaction-manifest.json`；`timeline-v1` 毫秒值与原始 `TranscriptChunk` 一致。真实桌面音频播放和 seek 仍未纳入。

**设计依据：** [检索韧性与会后体验设计](2026-08-31-retrieval-resilience-postmeeting-design.md)。

#### 阶段 8C：本地历史知识复用（知识卡片与会议决定）

**状态：基础实现已完成；真实 Vault 数据重建和长期回归待执行。**
**目标：** 将会后确认的知识卡片和会议决定以可追溯、低延迟的本地索引形式复用到下一次会议；不把历史全文无界注入实时 Prompt，不引入 embedding、Milvus 或外部向量服务。
**范围：** 仅沉淀两类对象：`knowledge_card`（关键词、别名、解释、来源和起源会议）与 `meeting_decision`（决定内容、范围、证据窗口、有效期和状态）。原始会议 Markdown、转写和 Vault 概念文件保持不可覆盖；索引是可重建的派生产物。
**检索策略：**

1. 规范化关键词/别名哈希命中（Unicode NFKC、大小写折叠、空白和连字符归一化）；
2. SQLite FTS5 中文 2-gram/ASCII token 索引，使用 `bm25()` 排序；
3. 元数据过滤：`kind`、`status`、`originMeeting`、`validUntil` 和更新时间；
4. 确定性字段加权后最多返回 3 条，并在卡片/Ask 上标记 `sourceType: "vault"`；
5. 未命中才继续现有垂直源和通用搜索，保持 fail-closed。

**实时性约束：** 索引写入只发生在会后 Vault 导出或显式重建任务中；实时请求只执行一次规范化、一次 FTS 查询和有限元数据过滤。不得在卡片 P95 链路中扫描整个 Vault、调用 embedding 模型或启动网络请求。Vault 索引不可用时退回现有检索，不阻塞实时链路。

**计划任务与文件边界：**

- 任务 1（数据契约与规范化）：新增 `lib/knowledge-memory.ts`，定义 `KnowledgeCardRecord`、`MeetingDecisionRecord`、规范化函数和统一命中类型；新增 `scripts/test-knowledge-memory.ts`，覆盖 Unicode/大小写/别名、空输入和状态过滤。
- 任务 2（SQLite FTS5 索引）：新增 `lib/knowledge-memory-store.ts`，复用 `CUEMIND_DATA_DIR`，建立 `knowledge_memory` 表和 `knowledge_memory_fts`（contentless FTS5）；提供幂等 upsert、按 kind/status/time 搜索和 JSONL 降级；新增 `scripts/test-knowledge-memory-store.ts`，覆盖新库、重复写入、FTS BM25 顺序和 SQLite 不可用回退。
- 任务 3（Vault 导出接入）：修改 `types/session.ts`、`app/api/vault-export/route.ts`、`lib/vault-exporter.ts`，支持显式会议决定字段并在会后导出成功后旁路写入索引；概念卡片导出同步写入索引；原始文件仍不可变，索引失败只记录本地错误。
- 任务 4（实时读取）：新增 `lib/local-memory-retrieval.ts` 和 `app/api/local-memory/route.ts`；先 exact/alias 再 FTS，返回最多 3 条带来源、状态和起源会议的结果。`app/api/context-cards/route.ts` 仅在关键词已通过现有硬规则后调用本地读取，命中直接生成历史卡片或作为本地证据，不改变网络回退和来源不足终态。
- 任务 5（回归与观测）：新增 `scripts/test-local-memory-route.ts` 和 `scripts/evaluate-local-memory.ts`，覆盖命中、别名、过期/被替代决定、空库、索引损坏、断网和实时延迟；报告写入 `reports/local-memory/<run-id>/`，不得写入 `dataset/`。
- 任务 6（历史重建）：新增 `scripts/rebuild-local-memory-index.ts`，只读扫描既有 `cuemind/concepts/*.md` 并幂等重建本地索引；Vault 不存在或文件损坏时跳过并输出计数，不修改原文件。

**异常矩阵归属：** 索引损坏、SQLite/JSONL 后端切换、重复 upsert、Vault 文件被人工编辑、过期或冲突决定、实时查询超时和本地索引不可用；所有异常必须退回现有检索或明确无历史上下文，不得编造决定。
**验收：** 规范化相同的关键词得到相同 cache/index key；卡片和决定可幂等写入并被 FTS5/BM25 检索；过期/`superseded` 决定不会作为当前结论注入；正常本地命中不产生网络调用且 P95 目标 ≤100ms（fixture 当前 P95 `1.01ms`）；本地索引失败不阻塞卡片链路；历史概念可通过重建脚本导入；现有 `test-context-card-route.ts`、`test-vault-exporter.ts`、`test-retrieval-resilience.ts` 全部回归通过。
**明确不做：** dense embedding、HNSW/IVF/PQ、cross-encoder rerank、自动从整段转写抽取未经确认的决定、云端知识库同步。

#### 阶段 8D：实时上下文记忆压缩（卡片触发与会中询问）

**状态：计划已登记；当前仅使用有界短窗口，尚未接入会话级 compact。**
**目标：** 控制长会议中的模型输入规模，避免旧话题污染卡片触发和会中询问，同时保留原始 confirmed 转录、知识卡片和会议决定作为可追溯事实。
**范围：** 仅覆盖卡片触发判断和会中询问两条实时链路；不压缩或覆盖 `transcriptChunks`，不改变阶段 8C 的本地知识索引，不涉及会后总结和后训练。

**记忆分层：**

1. 工作窗口：卡片触发保留最近 8 条 confirmed 转录或最近 30–60 秒；会中询问保留当前问题、最近 4–8 条 confirmed 转录和最近若干轮问答；
2. 会话摘要：异步维护结构化 `topics`、`shownKeywords`、`unresolvedQuestions`、`referencedCardIds` 和已确认的 `decisions`，只作为辅助上下文；
3. 长期记忆：知识卡片和会议决定继续由 SQLite FTS5/BM25 按需检索，模型只接收相关命中，不注入整个 Vault；联网检索正文只属于当前请求，不进入长期摘要。

**卡片触发判断：**

- 关键词判断只读取有界 confirmed 窗口、当前主题状态和已展示关键词集合；compact 摘要不得单独触发卡片；
- 摘要更新在后台执行，不阻塞关键词模型、检索或卡片生成；摘要不可用时继续使用短窗口和确定性去重；
- 卡片生成失败、超时或摘要压缩失败不得删除转录，不得改变 `model_skip`、重复抑制和 fail-closed 语义。

**会中询问：**

- 询问 Prompt 由当前问题、短转录窗口、上一版会话摘要、最多 3 条相关知识卡片/会议决定和本次检索证据组成；
- 达到模型上下文 60–70% 或累计 5–10 轮询问后触发异步 compact；先清理旧检索正文和工具结果，再压缩较早问答，始终保留当前问题和最近几轮原文；
- 摘要字段必须包含主题、已回答问题、未解决问题、引用卡片/决定 ID 和来源 URL；模型生成的摘要视为不可信数据，不能覆盖结构化事实；
- compact 失败时退回 token 裁剪，保留最新问题和最近上下文，并记录 `compression_failed`，不得阻塞当前回答。

**计划任务与文件边界：**

- 任务 1（契约）：新增 `lib/realtime-context-memory.ts`，定义工作窗口、摘要 schema、token/字符预算和版本号；新增纯函数测试，覆盖裁剪边界、当前问题保护、ID 保留和摘要失败回退；
- 任务 2（卡片触发）：修改 `hooks/useContextCards.ts`、`app/api/context-cards/route.ts`，接入短窗口与主题状态，验证 compact 不会单独触发卡片；
- 任务 3（会中询问）：修改 `hooks/useAsk.ts`、`app/api/ask/route.ts`，接入有界问答历史、异步摘要和失败回退；联网搜索、缓存和来源不足终态保持不变；
- 任务 4（会话状态）：以 `sessionId/runId` 关联摘要版本、输入 token、压缩前后 token、触发原因和失败码；只记录脱敏指标，不保存完整 Prompt 或检索正文；
- 任务 5（评测）：新增 compact fixture 和真实长会话回放，比较无压缩/仅裁剪/结构化摘要三种模式的卡片触发准确率、Ask 来源正确率、延迟、压缩比例和失败率；报告写入 `reports/context-compaction/<run-id>/`。

**异常矩阵归属：** 摘要模型超时、输出为空、摘要膨胀、摘要版本冲突、会话切换、网络搜索失败、索引不可用和客户端断线；均须保留原始事实并回退到短窗口或 token 裁剪。
**验收：** 卡片触发 P95 不因后台 compact 阻塞；会中询问上下文始终包含当前问题；compact 前后引用的卡片/决定 ID 不丢失；原始转录不可变；压缩失败不导致静默回答或错误卡片；三种模式有可比较的真实回放报告。
**明确不做：** 不把整段会议转录直接发送给模型；不使用 compact 摘要替代 confirmed 事实；不自动把普通问答写入阶段 8C 长期知识库；不引入新的向量数据库或云端记忆服务。

### 阶段 9：受控模型评估

**状态：候选登记、人工发布和回滚基础已完成，真实模型矩阵与影子运行待执行。**
**目标：** 用固定冻结集和硬件数据做模型选型，不引入线上自动优化。
**范围：** 对比 4B/8B、量化、KV cache、GPU 参数和候选蒸馏/EAGLE3；绑定模型哈希、llama.cpp、Prompt、来源策略和数据集版本；记录质量、吞吐、显存、首 token、P95、失败率和 ASR→卡片影响。
**异常矩阵归属：** 模型加载失败、OOM、超时、Schema 失败、影子运行偏差、发布中断和回滚。
**测评依据：** `lib/model-release.ts`、`scripts/test-model-release.ts`、模型基线 manifest 和冻结集报告。
**验收：** 每个候选有完整配置和对照报告；影子运行完成；人工决定 release/rollback；禁止自动换模、自动改 Prompt 或自动改权重。

### 阶段 10：本地产品化交接

**状态：Docker 与生命周期脚本已完成，干净主机和隔离断网交接待执行。**
**目标：** 交付可复现、可维护、可回滚的本地部署包。
**范围：** Docker 镜像/Compose、离线依赖与模型清单、配置模板、挂载目录、启动/停止/升级/回滚、断网验证、故障演练和运行手册；不包含多用户权限、集中式日志、自动更新和商业安装器。
**异常矩阵归属：** 镜像构建失败、容器启动失败、模型目录缺失、端口冲突、断网、升级失败、数据卷损坏和回滚。
**测评依据：** `Dockerfile`、`docker-compose.yml`、`scripts/cuemind-service.sh`、`scripts/verify-offline.sh` 和本地交接手册。
**验收：** 干净主机或隔离环境可启动核心流程；断网可完成重放和报告；升级失败可回滚；治理审计、发布责任和 evidence boundary 文档齐全。

#### 模型与硬件评估

EAGLE3、KV cache、不同量化档位、更强 GPU或蒸馏模型都只能作为候选版本实验。每次模型/参数变化必须绑定模型哈希、llama.cpp 版本、Prompt 版本、来源策略版本、数据集版本和完整冻结集结果。

模型训练不是默认路线。若训练，必须严格遵守决策 65：离线导出、训练、人工评估、人工决定替换；不允许线上自动改权重、Prompt 或 schema。

#### 真实性能与韧性测评补齐方案（2026-08-31）

**状态：执行器已实现，部分真实实测完成；4B timing、常驻 partial/confirmed 和完整全链路埋点待执行。**
**目标：** 补齐当前测评中缺失的真实 ASR 延迟/吞吐、llama.cpp 生成吞吐与首 token、逐请求阶段时间线，以及非破坏性 GPU/CPU 压力和恢复证据；不改变实时卡片、Live Ask、来源约束或降级语义。
**适用范围：** 阶段 7.7（ASR 可靠性）、阶段 7.8（模型基线）和阶段 8（本地可观测性）。本方案不引入 TTS；CueMind 当前没有语音输出链路，TTS 首音频字节指标保持 `not_applicable`。

**共同证据规则：**

- 所有命令先 `cd /home/work/asr/CueMind`；输入视频/音频仅从现有 `dataset/` 或明确的本地运行目录读取，报告不得复制原始音频和完整转写正文；
- 每次运行生成独立 `reports/performance-resilience/<run-id>/`，至少包含 `manifest.json`、`cases.jsonl`、`failures.jsonl`、`scorecard.json` 和 `report.md`；
- `manifest` 固定提交、模型/ASR 文件 SHA-256、llama.cpp/whisper.cpp 版本、硬件、GPU 参数、Prompt 版本、输入数据版本和采样口径；
- 真实服务、视频/音频回放、mock、fixture 必须分别标记，fixture 或控制流测试不得升级为真实延迟、质量或生产稳定性结论；
- 失败请求保留在分母中，P50/P95/P99 使用项目统一 nearest-rank 口径；不得通过删样本、改变超时或改写输入来消除失败。

**任务 1：真实 ASR 延迟与吞吐。**

- 新增 `scripts/evaluate-asr-latency.ts`，复用 `lib/local-asr.ts` 的 `transcribeWithWhisperCpp`；输入 manifest 至少包含视频/音频路径、音频时长、语言、模型和 `cold/warm` 标签；
- 视频模式先用 `ffmpeg` 抽取 16 kHz 单声道 WAV，再执行真实 whisper.cpp；实时模式使用固定视频按原时间速率回放，记录首个 partial、confirmed 提交、最终完成和恢复时间；
- 每个样本记录 `audioDurationMs`、`elapsedMs`、RTF、音频吞吐（audio seconds/second）、segment 数量、时间单调性、丢段/重复/乱序、进程 RSS 和错误终态；
- 至少覆盖 15 个本地视频中的有音频样本，并单独报告短音频、长音频、中文/中英混合、静音和断流注入样本；无音频视频只记录 `not_applicable`，不得伪造 ASR 结果；
- 验收：真实运行有完整分母和 P50/P95/P99；RTF、首 partial、confirmed 延迟可复现；confirmed 不回退、不重复；断流/超时要么恢复并记录恢复时间，要么 fail-closed。

**任务 2：llama.cpp tok/s 与 TTFT。**

- 扩展 `scripts/evaluate-model-providers.ts` 或新增 `scripts/evaluate-llama-timing.ts`，使用同一冻结集和真实 `llama.cpp` OpenAI-compatible endpoint；不把远端 API 延迟当作本地模型证据；
- 优先从 llama.cpp 响应中的 usage/timings 字段读取 prompt tokens、predicted tokens、prompt processing time、generation time 和 `predicted_per_second`；字段缺失时记录 `timing_unavailable`，不得用总耗时推算 tok/s；
- TTFT 定义为客户端发出请求到收到首个上游 SSE token/chunk。若服务端 Schema 缓冲导致只能看到 `answer_chunk`，同时记录 `first_event`、`upstream_first_token`（若可得）和 `buffered_first_byte`，不得将后者冒充 TTFT；
- 每个模型/量化/`-np` 配置至少执行冷启动 3 次、预热后 10 次，记录输入/输出 token、tok/s、TTFT、completion P50/P95/P99、Schema 失败和超时；
- 验收：同一配置的 timing 字段来源明确；4B/8B 当前候选均有可比较结果；缺失 TTFT 的运行标记为 `partial`，不能写成完整性能结论。

**任务 3：逐请求延迟时间线。**

- 新增统一时间线事件契约（建议 `lib/telemetry.ts` 扩展或新增 `lib/request-timeline.ts`），每个 `runId` 记录单调时钟的 `capture_start/end`、`asr_start/end`、`keyword_start/end`、`search_start/end`、`generation_start/end`、`render_start/end`、`first_event`、`first_token`、`complete` 和终态；
- 修改测评执行器而非改变业务响应协议，将每次请求写入 `timeline.jsonl`，并由报告脚本生成 `timeline-summary.json`；原始问题、转写正文和 trace payload 只保留脱敏摘要或哈希；
- 报告同时提供逐请求表、阶段耗时堆叠/瀑布数据、阶段占比、空洞时间（未归因开销）和按 cold/hot、answered/degraded/failed 分层的 P50/P95；
- 验收：任一请求的阶段时间可相加到总耗时（允许记录调度/网络空洞）；缺失阶段显式为 `null`；失败请求也有时间线；同一 `runId` 不得出现重复或倒序事件。

**任务 4：非破坏性资源压力与恢复。**

- 新增 `scripts/evaluate-resource-pressure.ts`，只使用受控并发和短时压力，不执行人工 OOM、不写入系统目录、不停止 systemd 管理的 llama 服务；
- 压力档位固定为：基线单请求、2 个并发请求、4 个并发请求（若队列/显存已接近上限则自动停止升档）；每 250–500ms 采样 `nvidia-smi` 的 GPU 利用率/显存、进程 RSS、系统 CPU、队列长度和请求终态；
- 在每个档位注入一次可恢复的请求超时、短暂网络失败或服务重启，记录检测时间、在途请求终态、后续请求恢复时间和是否影响 ASR；服务重启只能通过现有 systemd 操作；
- 验收：压力不导致数据损坏、请求无限阻塞或静默失败；每个失败有 `timeout/degraded/model_failed/recovered` 等终态；恢复探针连续通过后才结束该档位；报告明确“观测压力”与“未执行 OOM 压测”的边界。

#### 常驻 streaming `partial → confirmed` 替代方案

**状态：计划已登记；当前生产默认仍为 whisper.cpp CLI 分段调用。**
**目标：** 在不改变“partial 仅展示、confirmed 才入账并触发卡片”的产品语义下，引入常驻 Whisper worker，降低重复加载模型的开销，并提供稳定前缀确认、VAD 收尾和故障恢复证据。
**切换原则：** 新 worker 与现有 `/api/local-transcribe` CLI 路径并行存在；只有在冻结视频实时回放、长时稳定性、断流恢复和 confirmed 去重全部通过后，才允许人工切换默认模式。任何失败均可回滚到 CLI。

**阶段 0：协议与状态机冻结。** 定义 `runId`、`segmentId`、时间戳以及 `partial`、`confirmed`、`final`、`error`、`recovered` 事件；新增 `lib/realtime-asr-contract.ts` 和契约测试，覆盖空文本、乱序、重复 confirmed、未知事件和跨 run 数据；明确 `TranscriptChunk` 只接受 confirmed，并以 feature flag 保留 CLI fallback。

**阶段 1：常驻 worker 与 PCM 输入。** 新增常驻 worker，启动时加载一次 Whisper 模型，持续接收 16 kHz 单声道 PCM；新增 `lib/realtime-asr-client.ts` 对接本地 IPC/HTTP，记录 worker 健康、队列、模型哈希和设备参数；worker 不可用时只对新片段回退 CLI，不重复提交已确认文本。

**阶段 2：partial 流与前端隔离。** 每 200–500ms 解码最近 4–8 秒滑动窗口，输出带 ID 和时间戳的 partial；扩展麦克风/桌面 hook 及 streaming API，通过 SSE 或本地 WebSocket 推送；partial 只更新临时 UI，不写 `transcriptChunks`、候选账本或卡片链路；覆盖分片、取消和慢消费者测试。

**阶段 3：LocalAgreement-2 confirmed 水位。** 比较最近两次解码结果，将最长稳定前缀转为 confirmed，维护不可回退的 `confirmedUntilMs`；对重叠窗口做文本去重和时间裁剪，VAD 结束时执行 final decode；仅 confirmed 触发关键词/卡片，并测量首 partial、首 confirmed 和最终确认延迟。

**阶段 4：VAD、重启与恢复。** 增加 `silence → speech → trailing → finalized` 状态机；worker 崩溃、IPC 断开、GPU 初始化失败和超时按最后 confirmed 水位重连，丢弃未确认 partial；新增正常语音、静音切分、断流、重启、慢消费者和重复包 replay 测试，记录恢复时间并 fail-closed。

**阶段 5：真实回放、压力和人工发布。** 用 `dataset/` 有音频视频按原速回放，对 CLI/streaming 做 A/B，记录首 partial、首 confirmed、最终延迟、RTF、吞吐、资源、重复/漏段和卡片触发数；执行 10/30 分钟及 1/2 路受控并发，不执行 OOM；冻结协议、模型和参数，经人工 release/rollback 后才可切换默认模式。

**2026-08-31 执行记录：** 阶段 0–4 已实现并分别提交：`1f9a3af`、`a8263c0`、`1f9bde6`、`5282242`、`e354970`。契约、worker 队列/生命周期、SSE/LocalAgreement-2、final decode 与恢复回放定向测试，以及每阶段 `tsc`/lint 均通过。阶段 5 的真实 dataset 回放、10/30 分钟压力和资源采样未执行；用户随后明确授权将 streaming 设为生产默认，已通过配置提交切换，保留 `CUEMIND_REALTIME_ASR=cli` 回滚。自动门禁仍未通过，证据记录于 `reports/performance-resilience/realtime-asr-20260831/`；`dataset/` 未加入 Git。

**2026-09-01 实时上下文记忆压缩记录：** 已新增 bounded card/Ask context 契约、摘要指标持久化、压缩触发策略和确定性三策略评测；卡片仅使用短窗口，Ask 保留当前问题与最近问答，原始转录不可变。未执行真实长会议质量、来源正确率或生产延迟评测，报告位于 `reports/context-compaction/context-compaction-20260901/`。

**共同验收：** Trace 只保存 ID、时间戳、状态、耗时和错误码，不保存原始音频、完整转录或模型 payload；阶段 2 以前不得改变生产默认链路；每阶段独立测试、报告和本地 commit，任一门禁失败均保留 CLI 默认。

**执行顺序与提交：**

1. 先以 fixture/纯函数测试锁定时间线和 ASR/模型 timing 解析契约；
2. 再执行真实 ASR 和 llama.cpp 基线，确认服务健康后保存报告；
3. 运行逐请求时间线和资源压力矩阵，最后执行 `tsc`、lint、build 及既有回归；
4. 每项任务单独提交本地 commit；只有四项报告齐全且失败终态可解释，才能更新阶段 7.7/7.8 和阶段 8 的状态。

**明确不做：** 不接入 TTS；不把 `nvidia-smi` 单次快照当作压力测试；不进行破坏性 OOM；不引入自动扩容、自动换模、自动改 Prompt 或线上自适应参数。

## 6. 统一发布与验收门禁

每个阶段独立提交、独立验证。涉及代码时执行：

```bash
npx tsc --noEmit
npm run lint
pkill -TERM -f '[n]ext-server'
npm run build
npm run dev
curl -I http://localhost:3000/
```

随后执行该阶段相关的 `scripts/test-*.ts`。模型或推理参数变化还必须执行：

```bash
TMPDIR=/tmp npx tsx scripts/measure-ask-latency.ts
```

提交前必须确认：

- 没有 `dataset/`、`.env` 或模型文件进入暂存区；
- 没有打印密钥；
- 没有手动杀 llama-server；
- `:8082` health OK；
- `:3000` 返回 200；
- 报告保留完整分母、失败样本和 evidence boundary。

## 7. 决策映射

| 决策 | 在本文档中的执行位置 |
|---|---|
| 1 | 项目定位和面试演示边界 |
| 4 | 不编造、宁缺毋滥、只手动触发询问 |
| 26 | 候选账本和单候选终态 |
| 33 | 外发最小化和隐私降级根治 |
| 46-49 | 来源不可信隔离、可信等级、版本化回归和发布回滚 |
| 55 | 不宣称在线自学习；只做可治理的离线闭环 |
| 56 | SQLite 询问持久化 |
| 61-64 | vault 沉淀、只读消费、转写导出档位 |
| 65 | 人工把关、训练数据和真实决策轨迹 |
| 66 | partial/confirmed 与 ASR 2.1b |
| 67 | Live Ask、来源约束、隐私、延迟预算 |
| 68 | 三栏 UI 语义和询问入口 |

## 8. 变更记录

只在本文档末尾追加，不删除旧记录。每条记录必须包含日期、阶段、原因、涉及文件、验证命令和真实结果。

### 2026-08-30：建立唯一开发入口

- 将决策文档、优化路线图、handoff 和工程规范的关系统一到本文档。
- 当前阶段定为阶段 1：P0 延迟稳定性收口。
- 记录 `-np 1` 单轮冻结集结果：完成 P95 `6778ms`，8/8 成功；KV q8 对照不采纳。
- EAGLE3 未因下载失败判定为不可行，保留为阶段 7 候选实验。
- 后续新增开发内容、阶段状态和验收证据必须追加在本文档。

### 2026-08-30：阶段 1 稳定性复测与异常矩阵分层

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：确认 `-np 1` 是否只在单轮冻结集上偶然达标，并明确扩展评估与异常验证的归属。
- 变更：完成 `8 题 × 3 轮` 测量；将至少 30-50 题扩展题集、冷/热缓存分层和性能异常矩阵纳入阶段 1；将隐私外发异常矩阵纳入阶段 3；将落库、刷新/replay、总结、vault、训练导出和服务恢复的端到端异常矩阵纳入阶段 6。
- 证据：三轮均为 `8/8` 成功；完成 P95 分别为 `5859ms`、`3738ms`、`3861ms`；首事件 P95 分别为 `938ms`、`707ms`、`754ms`。第 2、3 轮搜索为缓存命中，结果标记为热缓存稳定性证据。
- 结论：冻结集三轮通过 7 秒预算，但 P0 尚未关闭；扩展题集和分层异常矩阵仍待执行。
- 遗留：服务已按用户要求关闭；下一次阶段 1 执行前需启动 `cuemind-llama.service` 和 `:3000`，再运行扩展评估，不得把本次热缓存结果当作生产级 P95。

### 2026-08-30：阶段 1 冻结集复测与扩展集阻塞确认

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：在服务恢复后复跑当前冻结 8 题，确认现行 8B、`-np 1` 基线，并核对阶段 1 是否具备关闭条件。
- 变更：修正 `scripts/cuemind-llama.service` fallback 模型路径为已验证的 `Qwen3-8B-Q4_K_M.gguf`；执行 `TMPDIR=/tmp npx tsx scripts/measure-ask-latency.ts`。
- 证据：真实 systemd 服务 health `{"status":"ok"}`，应用 `:3000` 返回 200；冻结集 `8/8`，首事件 P95 `782ms`，答案首字节/完成 P50 `4265ms`、P95 `5492ms`，阶段均值 keyword `469ms` / search `757ms` / generation `2958ms`，8 题均为 `answered`。
- 结论：冻结集本轮完成 P95 满足 `≤7000ms`，但 P0 仍未关闭；仓库未发现获授权的 30-50 题扩展集、冷/热分层实现或阶段 1 性能异常矩阵证据，不能进入阶段 2。
- 遗留：取得产品/数据授权后，按测评手册执行扩展集冷/热测评和异常矩阵；服务在本轮验证期间启动，交接状态恢复前应停止应用和模型服务。

### 2026-08-30：建立测评实现手册与阶段引用

- 阶段：阶段 1 / P0 文档收口。
- 原因：将测评执行口径、证据边界和异常矩阵固化为可执行手册，避免把 fixture/mock 或热缓存小样本包装成真实生产证据。
- 变更：新增 `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md`；更新本文档权威关系、阶段 1/3/6 测评引用、扩展题集授权边界和异常矩阵分层。
- 证据：检查仓库现有 `scripts/`、`fixtures/`、`reports/`；确认存在冻结集延迟脚本及既有模块回归，但未发现获授权的 30-50 题扩展数据集或扩展测评脚本；本轮未启动服务、未伪造测评结果。
- 结论：文档变更完成；阶段 1 仍进行中，P0 未关闭。
- 遗留：取得授权扩展集后，按手册执行冷/热缓存分层和性能异常矩阵；建议新增脚本路径为 `scripts/evaluate-ask-extended.ts`，ASR/回放/UI 端到端脚本亦须先登记后实现。

### 2026-08-30：阶段 1 回归矩阵复核

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：补充当前可执行的 fail-closed、卡片路由和询问让位回归证据，并排除执行器临时目录导致的假失败。
- 变更：未修改实时链路代码；使用 `TMPDIR=/tmp TMP=/tmp TEMP=/tmp` 执行现有回归脚本。
- 证据：`npx tsx scripts/test-ask-route.ts` 全部通过（来源不足降级、schema 违规、缓存、隐私边界、prompt 迁移）；`npx tsx scripts/test-context-card-route.ts` 全部通过；`npx tsx scripts/test-ask-card-concurrency.ts` 通过，卡片基线 P95 `176.9ms`、并发询问下 P95 `135.2ms`、比值 `0.764`（阈值 `<1.3`）。默认环境 `tsx` 因 Windows 挂载临时目录 IPC 不支持而报 `ENOTSUP`，改用 Linux `/tmp` 后测试正常执行。
- 结论：阶段 1 已具备冻结集和现有 mock/回归证据；P0 仍未关闭，扩展题集、冷/热分层和性能异常矩阵仍缺授权数据/完整实现。
- 遗留：不得进入阶段 2；等待授权扩展集或产品/数据方明确授权后继续阶段 1。

### 2026-08-30：阶段 1 模型与搜索异常回归

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：补充计划要求的模型/搜索异常和 fail-closed 控制流证据。
- 变更：未修改实时链路；执行 `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npx tsx scripts/test-model-providers.ts` 与 `TMPDIR=/tmp TMP=/tmp TEMP=/tmp npx tsx scripts/test-vertical-sources.ts`。
- 证据：模型提供方回归通过，覆盖不可达、超时、HTTP 错误、非法 JSON、schema 错误及安全错误序列化；垂直源回归通过，覆盖 arXiv/HN/GitHub/SO 解析、去重短路、Tavily 回退、来源不足和错误终态。
- 结论：阶段 1 已有 mock/fixture 异常控制流证据；P0 仍未关闭，真实扩展题集冷/热性能与服务重启/显存压力矩阵仍待执行。
- 遗留：扩展数据授权前不新增或复制题集；阶段 2 不得提前开工。

### 2026-08-30：阶段 1 扩展测评执行器就绪

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：为已登记的 30-50 题扩展集建立可重复执行入口，但不在未授权时生成或扩展数据。
- 变更：新增 `scripts/evaluate-ask-extended.ts` 和 `scripts/test-evaluate-ask-extended.ts`。执行器要求外部 `ASK_EXTENDED_MANIFEST` 明确声明 `authorized=true`，读取每题 `id/question/cacheMode`，分别输出 cold/hot 的首事件、答案首字节、完成 P50/P95/P99、失败分母、终态和 cache mode mismatch；缺失或非法 manifest 直接退出，不启动服务、不清缓存、不写应用数据库。
- 证据：`TMPDIR=/tmp TMP=/tmp TEMP=/tmp npx tsx scripts/test-evaluate-ask-extended.ts` 通过；`npx tsc --noEmit` 通过；`npm run lint` 无错误，仅保留既有 `lib/partial-transcript.ts:63` warning；缺失 `ASK_EXTENDED_MANIFEST` 的 CLI 验证以非零状态退出并提示不会自动创建数据。
- 结论：扩展测评实现缺口已收口；阶段 1/P0 仍未关闭，因授权 30-50 题数据、真实冷/热运行和完整性能异常矩阵结果尚未具备。
- 遗留：取得授权 manifest 后直接运行 `ASK_EXTENDED_MANIFEST=<authorized-manifest> TMPDIR=/tmp npx tsx scripts/evaluate-ask-extended.ts`；在此之前不得进入阶段 2。

### 2026-08-30：阶段 1 扩展数据规模门禁

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：防止小样本或误授权 manifest 被误当作至少 30 题扩展集执行。
- 变更：`scripts/evaluate-ask-extended.ts` 增加执行时最少 30 个授权题目的门禁；解析层仍可接受小 fixture 供契约测试使用。
- 证据：`TMPDIR=/tmp TMP=/tmp TEMP=/tmp npx tsx scripts/test-evaluate-ask-extended.ts` 通过；`npx tsc --noEmit` 通过。
- 结论：扩展测评执行器具备数据规模保护；阶段 1 仍未关闭，当前没有授权 manifest 可运行。
- 遗留：获得至少 30 题授权 manifest 后，执行 cold/hot 分层并记录完整分母、异常终态和分位数。

### 2026-08-30：阶段 1 ask 路由模型失败终态

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：异常矩阵需要验证模型生成失败时的路由级 fail-closed 行为，而不只验证底层 provider 错误映射。
- 变更：扩展 `scripts/test-ask-route.ts` mock provider，新增生成 HTTP 失败用例；不修改生产路由。
- 证据：`TMPDIR=/tmp TMP=/tmp TEMP=/tmp npx tsx scripts/test-ask-route.ts` 通过；新增用例确认无 `answer_chunk`、终态 `model_failed`、搜索来源保留且错误原因可见。
- 结论：阶段 1 ask 路由的模型失败控制流证据补齐；P0 仍未关闭，扩展集冷/热真实性能和服务重启/显存压力证据仍缺失。
- 遗留：继续等待授权扩展 manifest，不得进入阶段 2。

### 2026-08-30：阶段 1 关闭条件审计

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：避免在缺少扩展数据时重复执行相同测评，并按验收条件逐项核对当前证据。
- 已满足：8 题冻结集真实复测 8/8；首事件 P95 `782ms`；完成 P95 `5492ms`；ask/card/model/search 回归控制流通过；fallback 单元已与 8B systemd 配置对齐；扩展测评执行器和至少 30 题门禁已提交。
- 未满足：至少 30-50 题授权扩展 manifest；扩展集 cold/hot 真实运行及完整 P50/P95/P99 分母；服务重启/显存压力真实性能矩阵；因此不能将 P0 标记关闭或进入阶段 2。
- 证据：仓库及 `/home/work/asr` 范围内未发现明确 `authorized=true` 的扩展 manifest；现有 `reports/ab-8b-eval/cases.jsonl` 仅 8 行，不能作为扩展集。
- 结论：阶段 1 保持进行中；当前没有不依赖外部授权且能满足关闭条件的下一步实现工作。
- 遗留：收到产品/数据方授权 manifest 后，运行 `ASK_EXTENDED_MANIFEST=<path> TMPDIR=/tmp npx tsx scripts/evaluate-ask-extended.ts`，再重新执行阶段 1 门禁。

### 2026-08-30：阶段 1 视频内容扩展题集实测

- 阶段：阶段 1 / P0 延迟稳定性收口。
- 原因：用户明确允许直接使用 `dataset/` 视频数据，不以授权状态作为扩展题集前置条件。
- 变更：新增 `fixtures/ask-extended-v1.json`，包含 5 个本地视频衍生的 38 题，覆盖短/中/长、中英混合、Agent memory、微调、前端、LLM/Agent 产品地图、Agent Harness，以及关键词提取、垂直源和通用回退标签；扩展 evaluator 改为授权字段可选并保留来源元数据。
- 证据：`ASK_EXTENDED_MANIFEST=fixtures/ask-extended-v1.json ASK_EXTENDED_OUTPUT_DIR=reports/ask-extended-video-20260830 TMPDIR=/tmp npx tsx scripts/evaluate-ask-extended.ts`；总分母 38，失败 2（`invalid_schema`），完成 P50/P95/P99 `4808/6819/7218ms`，首事件 P95 `858ms`；cold 19 题失败 1，hot 19 题失败 1，hot 标记与实际缓存命中不一致 17 次。
- 结论：扩展数据和真实测评入口已具备，但 P0 未关闭：存在 schema 失败、P99 超过 7 秒、缓存模式标记不一致，且服务重启/显存压力矩阵尚未执行。
- 遗留：保留失败证据，进行模型/提示与缓存语义裁决；不得通过删题、改预算或把失败题改写为通过，阶段 2 不得开始。

### 2026-08-30：视频重新导入与卡片驱动测评协议

- 阶段：阶段 1 / P0 延迟稳定性收口（证据链补充）。
- 原因：确认扩展题集必须来自视频内容抽取或实际卡片，而不是仅凭人工阅读视频生成问句。
- 变更：在测评手册中登记完整协议：有音频视频执行本地 ASR，无音频视频执行帧抽样与 OCR/视觉抽取；将证据导入卡片生成链路，保存卡片、关键词、来源、终态和 `video → segment → card → ask → case` lineage；未完成链路的题集只能作为补充 fixture。
- 证据：本条为执行前规范变更，尚未声称视频重新导入、卡片生成或询问测评已完成。
- 结论：文档协议已登记；下一步先实现/执行内容抽取和 lineage，再重新生成询问集与冷热缓存测评。
- 遗留：需要确认现有本地 ASR、视频帧/OCR 工具和卡片入口的可执行命令；执行结果必须单独写入新报告目录，不覆盖既有报告。

### 2026-08-30：Whisper CUDA 配置与验证

- 阶段：阶段 1 / 视频重新导入前置。
- 原因：CPU-only Whisper 无法在可接受时间内完成当前视频集的完整 ASR。
- 变更：在 `/home/work/asr/whisper.cpp` 以 `GGML_CUDA=ON`、CUDA 12.3、`CMAKE_CUDA_ARCHITECTURES=89` 构建独立 CUDA 版本；CueMind 新用户默认路径指向该二进制和现有 `ggml-small.bin`，不覆盖已有用户设置。
- 证据：`ldd` 显示 `libggml-cuda.so`、`libcudart.so.12`、`libcublas.so.12`；12 秒视频样本运行日志显示 `found GPU device 0: NVIDIA GeForce RTX 4060 Ti`、`using CUDA0 backend`，总耗时约 `1145ms`。
- 结论：CUDA ASR 前置配置通过；尚未声称 6 个视频完整转录、卡片生成或卡片驱动询问测评完成。
- 遗留：使用 CUDA 二进制执行可恢复的分窗全量转录，随后导入卡片链路并生成 lineage。

### 2026-08-30：视频集 CUDA 全量 ASR

- 阶段：阶段 1 / 视频重新导入前置。
- 原因：完成 CUDA 配置后的真实视频转写执行，替代此前 CPU-only 的不可接受吞吐。
- 变更：使用 `/home/work/asr/whisper.cpp/build-cuda/bin/whisper-cli`、`ggml-small.bin`、`-dev 0 -fa` 对当前 `dataset/*.mp4` 6 个视频逐一抽取 16kHz 单声道 WAV 并生成 JSON/TXT transcript；输出位于 `reports/video-reimport-20260830-cuda/`，支持按 JSON 文件断点跳过。
- 证据：6/6 视频完成；每个日志均含 `whisper_backend_init_gpu: using CUDA0 backend`。处理耗时分别约 `41.7s/2127.5s`、`142.0s/3305.6s`、`27.2s/916.5s`、`12.8s/1016.9s`、`7.6s/862.9s`、`68.4s/2865.6s`（处理秒数/音频秒数）。
- 结论：当前视频集已获得 CUDA Whisper 全量 ASR 产物；本证据只覆盖视频到 transcript，不覆盖卡片生成、询问 lineage 或 Live Ask 延迟门禁。
- 遗留：从 transcript 分窗生成实际 context cards，保存卡片/关键词/来源/终态及 `video → segment → card → ask → case` lineage，再执行卡片驱动询问测评。

### 2026-08-30：中文 ASR 卡片驱动链路抽样

- 阶段：阶段 1 / 视频重新导入与 Live Ask 证据补充。
- 原因：使用强制 `-l zh` 的全量 transcript，避免自动语言识别将中文内容误判为英文。
- 变更：新增 `scripts/evaluate-video-card-lineage.ts`；从每个视频均匀抽取 5 个候选 30 秒窗口，调用真实 `/api/context-cards` 由模型决定 `search/skip`，仅对 `card_shown` 再调用 `/api/ask`，输出 `lineage.jsonl` 与 `manifest.json`。
- 证据：报告目录 `reports/video-card-lineage-20260830-zh/`；30/30 卡片 `card_shown`，30/30 `verticalHit=true`；询问 27 `answered`、3 `invalid_schema`。所有询问 `cacheHit=true`，原因是卡片链路先写入共享 term cache，故本轮不作为 cold/hot 对照证据。
- 结论：视频 → ASR → 卡片 → 询问 lineage 抽样已真实执行；ASR 内容质量明显优于自动语言版本，但仍有 3 个询问 schema 失败，且缓存被上游卡片预热，阶段 1 仍未关闭。
- 遗留：增加测试专用缓存隔离/清理并重新执行严格冷热缓存测评；`/api/ask` 已增加 markdown JSON 外壳兼容和 `invalid_schema` 细分诊断，需在服务重启后复跑以取得 3 个历史样本的具体诊断。

### 2026-08-30：历史 invalid_schema 三题重测

- 证据：`reports/video-card-lineage-20260830-zh/invalid-schema-recheck-20260830-final.jsonl`；服务重启后真实调用 3 题。
- 结果：`1085年` -> `degraded`（`sources_empty`，搜索结果与术语无关，未回放无依据答案）；`规则扰动` -> `answered`；`Safe2G` -> `answered`。后两题均为 `confidence=low`，引用搜索结果并保留完整来源。
- 结论：3 个历史 `invalid_schema` 均已不再以不可解释的 schema 终态结束；其中 1 个按 fail-closed 规则降级，2 个恢复正常回答。此次结果为热缓存（`cacheHit=true`），不作为冷热性能对照。

### 2026-08-30：扩展题集冷热缓存控制复测

- 变更：`/api/ask` 支持评测用 `cacheMode`/`cacheKey`；扩展 evaluator 对 hot 题先预热同一稳定键，cold 题跳过缓存读写。
- 证据：`reports/ask-extended-video-20260830-v3/scorecard.json`；38 题、失败 0；cold 19/19 命中语义正确，hot 仍 15 次 miss，hot 完成 P95 `7899ms`，总完成 P95 `7299ms`。
- 结论：缓存控制已可审计，但模型关键词不稳定导致预热键未必命中；阶段 1 继续进行中，P95 超预算且冷热门禁未通过，不能进入阶段 2。

### 2026-08-30：稳定 cacheKey 完整预热复测

- 变更：扩展 evaluator 的 hot 预热等待 SSE body 完整结束，并对预热/正式请求传递同一稳定 `cacheKey`。
- 证据：`reports/ask-extended-video-20260830-v4/scorecard.json`；38 题失败 0；cold mismatch `0`，hot mismatch `2`；hot 完成 P95 `5052ms`，总完成 P95 `6115ms`。
- 结论：热缓存命中语义基本稳定；2 次 mismatch 对应预热降级、无缓存可写入。按用户指示本轮不因 P95 中止，但阶段 1 仍需完成异常矩阵和剩余缓存降级场景核验。

### 2026-08-30：阶段 1 异常矩阵

- 证据：`reports/phase1-anomaly-matrix-20260830/report.md`；关键词提取回退、搜索失败/来源不足、模型失败/超时、schema 违规、服务重启恢复均完成验证，控制流回归通过。
- 真实恢复：`systemctl restart cuemind-llama.service` 后 `:8082` health OK、`:3000` HTTP 200；`nvidia-smi` 记录 RTX 4060 Ti 显存 `6433/8188 MiB`、GPU 利用率 `16%`。
- 边界：显存压力仅做非破坏性观测，未执行人工 OOM 压测；阶段 1 仍保留该项真实性限制。

### 2026-08-30：异常矩阵与冷热最终复测

- 变更：热缓存统计区分 `warmFinalState=answered` 的可缓存预热与预热降级；仅前者计入 hot miss。
- 证据：`reports/ask-extended-video-20260830-v5/scorecard.json`；38 题失败 0，cold/hot mismatch 均为 0，schema 失败 0；hot 完成 P95 `4293ms`，总完成 P95 `5806ms`，cold P99 `9032ms`。
- GPU 压力：2 路并发请求期间利用率 95-100%、显存 6424-6565/8188 MiB，无超时；服务重启后 health OK、应用 200。
- 结论：本轮已满足冷热命中和 schema 要求；按用户指示忽略 P95 门禁阻断，但保留 cold P99 超时风险证据。阶段 1 还需产品确认是否接受 P99 风险后再标记关闭。

### 后续记录模板

### 2026-08-31：登记阶段 8C 本地历史知识复用计划

- 阶段：阶段 8C / 本地历史知识复用。
- 原因：用户确认下一次会议只复用两类沉淀内容：知识卡片和会议决定，并要求采用规范化关键词哈希表、SQLite FTS5 + BM25 和元数据索引，同时保持实时性。
- 变更：新增阶段 8C 计划，定义数据契约、索引写入、实时读取、异常矩阵、测试报告和明确排除项；实时链路不引入 embedding、Milvus 或 rerank。
- 证据：已核对 `CLAUDE.md`、产品决策文档和现有 `session-store` 的 FTS5/BM25 实现；当前 Vault 读方向仍未接入实时 `context-cards`，故本阶段作为独立实现任务登记。
- 结论：计划已登记，尚未声称代码完成；执行顺序为数据契约 → SQLite 索引 → Vault 写入 → 实时读取 → 回归测评。
- 遗留：按阶段 8C 任务逐项实现，每项完成后运行定向测试并提交本地 commit。

### 2026-08-31：阶段 8C 基础实现与本地索引评测

- 阶段：阶段 8C / 本地历史知识复用。
- 原因：落实知识卡片、会议决定在下一次会议中的低延迟本地复用，不改变既有网络检索和 fail-closed 规则。
- 变更：新增 `lib/knowledge-memory.ts`、`lib/knowledge-memory-store.ts`、`app/api/local-memory/route.ts`；Vault 导出支持显式 `decisions` 并旁路索引卡片/决定；`context-cards` 在关键词硬规则通过后注入最多 3 条本地历史证据；新增 `scripts/rebuild-local-memory-index.ts`、契约/存储/路由/评测脚本。
- 证据：`TMPDIR=/tmp npx tsx scripts/evaluate-local-memory.ts` → SQLite、6/6 fixture、P50 `0.19ms`、P95 `1.01ms`、无网络；`test-knowledge-memory.ts`、`test-knowledge-memory-store.ts`（SQLite/JSONL）、`test-local-memory-route.ts`、`test-vault-exporter.ts`、`test-context-card-route.ts`、`test-retrieval-resilience.ts` 均通过；`npx tsc --noEmit --pretty false` 和 `npm run lint` 通过。
- 结论：阶段 8C 基础实现完成；本地命中不增加网络调用，过期/`superseded` 决定 fail-closed，索引不可用时不阻塞实时卡片链路。
- 遗留：在目标 Vault 上执行重建脚本并补充真实会议数据的 Recall@3/误注入率；当前评测为 fixture，不代表真实语料覆盖率。

### 2026-08-31：真实性能与韧性测评补齐执行器

- 阶段：阶段 7.7/7.8、阶段 8 / 真实性能与韧性测评补齐。
- 原因：补齐真实 ASR 延迟与吞吐、llama.cpp tok/s/TTFT、逐请求时间线和非破坏性资源压力/恢复四项测评缺口。
- 变更：新增 `lib/performance-metrics.ts`、`lib/llama-timing.ts`、`lib/request-timeline.ts`；新增 `scripts/evaluate-asr-latency.ts`、`scripts/evaluate-llama-timing.ts`、`scripts/evaluate-request-timeline.ts`、`scripts/evaluate-resource-pressure.ts` 和 `scripts/test-performance-metrics.ts`。所有执行器均输出独立 `manifest/cases/failures/scorecard/report`，失败保留在分母中。
- 真实证据：`reports/performance-resilience/asr-smoke-20260831/` 真实 CUDA whisper.cpp 视频样本 1 个，音频 `1377431ms`、处理 `52921ms`、RTF `0.0373`、吞吐 `26.03 audio-sec/sec`、46 个 segment 无乱序/重叠/重复；`reports/performance-resilience/llama-smoke-20260831/` 真实 llama.cpp SSE 8 题，8/8 成功，tok/s P50 `47.70`，上游首 token P50/P95 `71.8/928.0ms`，完成 P50/P95 `656/1971ms`；`reports/performance-resilience/timeline-smoke-20260831/` 真实 `/api/ask` 3/3 请求含 `runId` 时间线，缺失 capture/ASR/render 事件显式统计；`reports/performance-resilience/pressure-smoke-20260831-v2/` 1/2 并发共 3 请求均成功，GPU 采样约 `3–96%`、显存约 `6840–6844MiB/8188MiB`，应用和 llama health 恢复探针均通过。
- 验证：`npx tsc --noEmit --pretty false`、`npm run lint`、`TMPDIR=/tmp npx tsx scripts/test-performance-metrics.ts`、`scripts/test-asr-reliability.ts`、`scripts/test-realtime-replay.ts` 和 `npm run build` 均通过；build 仅保留既有 `module.createRequire failed parsing argument` 警告。
- 结论：四项测评的可复现执行器和真实小规模样本已具备；ASR partial/confirmed 在 CLI per-request 模式不可得，Ask 路由的 capture/ASR/render 事件尚未暴露，故对应字段保持 `null`，不将 buffered first byte 冒充 TTFT。
- 遗留：扩大 ASR 至全部 15 个有音频视频并执行分层长时回放；对 4B/8B 各完成冷启动 3 次与预热 10 次；补齐业务链路的 capture/ASR/render 事件；在确认显存余量后再决定是否执行 4 并发档位；不得进行破坏性 OOM。

### 2026-08-31：真实性能与韧性测评扩展实测

- 阶段：阶段 7.7/7.8、阶段 8 / 真实性能与韧性测评补齐。
- 变更：使用 `scripts/evaluate-asr-latency.ts` 对 `dataset/` 15 个视频执行真实 CUDA whisper.cpp 全量测评；使用 `scripts/evaluate-llama-timing.ts` 对当前 8B 服务执行 8 题 × 3 轮 SSE timing；使用 `scripts/evaluate-resource-pressure.ts` 完成 1/2/4 并发非破坏性资源观测。
- 证据：`reports/performance-resilience/asr-all-20260831/` 15/15 成功，累计音频 `28316.7s`、处理 `1065.4s`，RTF `0.03763`、吞吐 `26.58 audio-sec/sec`、失败 `0`；`reports/performance-resilience/llama-8b-3x-20260831/` 24/24 成功，服务端 timing 可得 `24/24`，tok/s P50/P95 `43.03/43.95`，上游首 token P50/P95 `34.8/137.3ms`，完成 P50/P95 `710/893ms`；`reports/performance-resilience/pressure-1-2-4-20260831/` 1/2/4 并发共 `7` 请求全部回答，GPU 高负载采样约 `91–96%`，显存峰值约 `7055/8188MiB`，三档应用和 llama health 均通过。
- 辅助证据：`reports/performance-resilience/timeline-smoke-20260831/` 真实 `/api/ask` 3/3 请求生成逐 `runId` 时间线；搜索/生成阶段中由服务端耗时反推的事件标记为 `derived`，capture/ASR/render 未暴露字段保持显式缺失。
- 结论：真实 ASR 离线处理吞吐、当前 8B llama.cpp tok/s/上游首 token、Ask 请求时间线和受控资源压力/恢复均已有可复现报告；本轮没有执行破坏性 OOM，也没有把服务端缓冲后的答案首字节冒充 TTFT。
- 遗留：4B 模型需通过独立 systemd 评测实例补齐同口径 timing，不能仅修改请求体模型名；若要证明实时 partial/confirmed，需实现常驻 whisper streaming/LocalAgreement-2；若要得到完整 ASR→卡片→渲染瀑布图，需在生产链路增加不含正文的阶段事件埋点。

### 2026-08-31：生产链路原生事件埋点落地

- 阶段：阶段 7.7/7.8、阶段 8 / 逐请求时间线与本地可观测性。
- 目标：为 Capture、ASR、关键词和渲染提供真实边界事件，并用单一 `runId` 关联同一音频片段的后续卡片请求。
- 变更：新增 `PipelineEvent` 契约、单调时间戳与重复/倒序校验；桌面与浏览器录音段发出 `capture_start/end`、`asr_start/end`；context-card 和 Ask 路由发出 `keyword_start/end`；卡片 React DOM commit 前后发出 `render_start/end`。客户端事件通过 `/api/pipeline-events` 脱敏旁路写入本地 JSONL，服务端事件同步写入 `reports/performance-resilience/native-events.jsonl`，任何写入失败均不影响主链路。
- 证据：`TMPDIR=/tmp npx tsx scripts/test-request-timeline-events.ts`、`scripts/test-pipeline-event-store.ts`、`scripts/test-local-transcribe-contract.ts`、`scripts/test-context-card-route.ts`、`scripts/test-ask-route.ts`、`scripts/test-media-upload-route.ts` 全部通过；`ASK_MEASURE_BASE_URL=http://localhost:3001 TMPDIR=/tmp REQUEST_TIMELINE_OUTPUT=reports/performance-resilience/timeline-native-20260831-live3 npx tsx scripts/evaluate-request-timeline.ts` 3/3 请求成功，关键词原生事件 3/3 可见，capture/ASR/render 在 Ask-only CLI 中按边界保持 `null`。
- 约束：`render_end` 是 `useLayoutEffect` 的 DOM commit 后近似，不代表 OS compositor 绘制完成；CLI 评测不伪造浏览器音频/渲染事件，旧 SSE 推导边界显式标记 `derived`。
- 验收：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过。Build 仍显示既有 `better-sqlite3` 的 `module.createRequire` warnings，不影响产物生成。

```markdown
### YYYY-MM-DD：<阶段/变更名称>

- 阶段：阶段 N / Pn。
- 原因：对应决策编号和路线图条目。
- 变更：实际修改的文件和行为。
- 证据：执行的命令、样本规模、真实输出摘要。
- 结论：通过、未通过、降级或阻塞；不得使用未验证的“完成”。
- 遗留：下一步和未解决风险。
```
