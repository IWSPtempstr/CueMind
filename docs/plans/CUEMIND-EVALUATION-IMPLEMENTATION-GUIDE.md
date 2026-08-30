# CueMind 测评实现手册

> 用途：规定 CueMind 如何执行、记录和解释测评。本手册负责“怎么测”；产品语义以 `docs/product/cuemind-grilling-decisions.md` 为准，阶段顺序与状态以 `CUEMIND-MASTER-DEVELOPMENT-PLAN.md` 为准。
>
> 状态：执行规范，2026-08-30 建立。本文不把 mock、fixture、SSR 替代验证或小样本结果包装为真实生产证据。

## 1. 测评目标、范围与证据边界

测评目标是证明实时 ASR、上下文卡片、Live Ask、三栏交互、SQLite/replay、vault、只读 MCP 和离线训练导出的行为满足锁定决策、fail-closed 约束和发布门禁。每次报告必须同时记录：仓库提交、模型文件 sha256、llama.cpp 版本、Prompt/来源策略版本、运行参数、数据集版本、主机/GPU、时间、样本分母、失败样本和异常终态。

证据分四类，报告中必须逐项标记：

| 类型 | 允许证明 | 不允许声称 |
|---|---|---|
| 真实环境 | 真机音频、真实服务、真实搜索和真实 SQLite/vault 运行结果 | 未运行的场景已通过 |
| mock | 注入模型/搜索/数据库故障后的控制流和 fail-closed 行为 | 真实延迟、真实来源质量 |
| fixture | 固定 JSON/JSONL 的 schema、解析、统计和幂等性 | 真实 ASR 或生产分布 |
| SSR/替代验证 | 纯函数、服务端渲染、无浏览器环境下的契约验证 | 麦克风、点击、视觉布局或端到端用户体验 |

不存在的脚本、数据集和报告不得写成已完成事实；需要新增时，先在报告和主计划中登记准确路径、输入契约和实现范围。

## 2. 通用执行与统计

所有命令先 `cd /home/work/asr/CueMind`。模型测评前检查 `curl -fsS http://127.0.0.1:8082/health`；应用测评前检查 `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/`。服务启动/停止由阶段计划授权，不能把服务未启动误记为模型失败。

延迟以每个请求的单调时钟计算：首事件、答案首字节（若服务端 schema 缓冲则单独注明）、完成事件。P50/P95/P99 使用排序后的 nearest-rank（`ceil(p*n)`，n 为该指标实际样本数）；失败请求不从总请求分母删除，必须同时报告请求成功率、正常回答分母、失败率和失败样本。冷缓存须清理或隔离搜索缓存并记录方法；热缓存须明确命中字段，二者不得合并。

建议报告格式：`manifest.json`（版本/环境/口径）、`cases.jsonl`（逐样本输入、阶段耗时、终态）、`failures.jsonl`（完整失败原因和响应摘要，不含密钥/音频/原始 trace payload）、`scorecard.json`（分母、分位数、通过判定）、`report.md`（结论与证据边界）。

## 3. ASR 测评

### 视频重新导入测评协议（2026-08-30）

视频内容题集必须先经过内容抽取，再进入卡片与询问链路，不得把人工根据画面写出的问句当作完整视频理解证据。对有音频视频执行完整本地 ASR；对无音频视频执行视频帧抽样、OCR/视觉内容抽取，并记录抽帧时间。随后将带时间定位的 transcript/视觉片段导入 CueMind 卡片生成链路，保存实际卡片、关键词、来源和终态；询问题目只能从实际卡片或其对应证据片段生成。

每个视频样本必须输出 `video-manifest.json`、`transcript/` 或 `vision/`、`cards.jsonl`、`asks.jsonl` 和 `lineage.jsonl`。`lineage` 至少关联 `video -> segment -> card -> ask -> evaluation case`，并记录抽取器版本、模型版本、时间范围和失败原因。只有完成该链路的样本才能计入“转录/卡片驱动问答”证据；人工视频衍生题集只能作为补充延迟 fixture。

| 项目 | 输入 | 执行命令或脚本 | 观察字段 | 通过标准 | 证据输出 | 边界 |
|---|---|---|---|---|---|---|
| partial 首次出现 | 授权真机麦克风/短音频，含静音起始 | 已有 `npx tsx scripts/test-partial-transcript.ts`；真机延迟需新增 `scripts/evaluate-asr-latency.ts` | 首个 partial 触发/出现时间、音频时长 | 触发门限符合决策 66；真机时间如实记录 | cases + latency summary | 单测不能证明真机首现 |
| confirmed 延迟 | 连续语音窗口 | `scripts/evaluate-asr-latency.ts`（待新增） | confirmed 时间、窗口边界 | 窗口闭合语义不变，异常终态可解释 | cases/failures | CLI per-request 不是完整 LocalAgreement-2 |
| 转写一致性 | 同一音频的整窗基线与 partial/confirmed 输出 | `npx tsx scripts/test-local-asr.ts`；一致性抽样需上述新脚本 | normalized text、WER/关键短语 | 记录抽样结果，不把未执行目标写成通过 | transcript comparison | 无授权音频时只能 fixture |
| 中英混合/噪声/多人/语速 | 授权分层音频集；每层有独立分母 | `scripts/evaluate-asr-latency.ts --manifest <path>`（待新增） | 语言、噪声、speaker、语速、丢段/重复/乱序 | 各层均报告，不以总体平均掩盖失败 | 分层 scorecard | 数据集需产品/数据授权 |
| 长时运行 | 授权长音频或连续麦克风会话 | `scripts/evaluate-asr-latency.ts --duration ...`（待新增） | segment 序号、时间单调性、内存/错误 | 无丢段、重复、乱序；异常可恢复或 fail-closed | event log + failures | 未运行服务不得声称稳定 |

## 4. 上下文卡片

执行基线：`npx tsx scripts/evaluate-context-cards.ts`、`npx tsx scripts/test-context-card-route.ts`、`npx tsx scripts/test-candidate-store.ts`、`npx tsx scripts/test-ask-card-concurrency.ts`。fixture 只能验证契约，真实搜索需标记真实环境。

| 项目 | 输入/执行 | 观察与通过标准 | 证据边界 |
|---|---|---|---|
| trigger precision/recall/F1 | 带人工 gold 的 confirmed 窗口；按 term/candidate 统计 | TP/FP/FN/TN、precision、recall、F1；完整分母 | fixture 或真机必须分开 |
| 卡片延迟、schema、来源 | 真实/注入搜索结果 | card P50/P95、schema 合法率 100%、来源有效率；来源少于 2 条按规则降级 | mock 不证明外部来源质量 |
| 来源不足降级 | 0/1 条来源和冲突来源 fixture | 降级终态、无编造答案、无错误卡片 | 控制流证据 |
| 重复/cooldown/账本 | 重复 term、并发 term、冷却窗口 | 单候选终态、抑制原因、card_id、created_at 可追溯 | 需 SQLite 或等价 fixture |
| 与 Live Ask 并发 | `npx tsx scripts/test-ask-card-concurrency.ts` | 询问让位且卡片链路不回退 | 脚本级并发，不等同浏览器体验 |

## 5. Live Ask

冻结集使用现有 `npx tsx scripts/measure-ask-latency.ts`，固定 8 题且不可改题或预算。扩展题集属于阶段 1，目标至少 30–50 题；可使用用户提供的本地视频衍生数据，manifest 的授权字段可选，但必须记录来源和证据边界，不得复制冻结题集冒充新数据。`scripts/evaluate-ask-extended.ts` 范围仅为读取 manifest、冷/热缓存分层、逐题 SSE 计时和 JSONL 报告。

每轮必须记录：首事件延迟、答案首字节口径、完成 P50/P95/P99、8 题冻结集与扩展集的独立分母、冷/热缓存标签、失败率/异常终态、关键词提取/搜索/生成分段耗时。`npx tsx scripts/test-ask-route.ts` 覆盖来源不足、schema 违规、缓存和隐私契约；mock 的模型超时、搜索失败和 schema 失败只能证明 fail-closed 控制流。正常回答 P95 超过 7000ms 时保留失败证据并暂停产品/推理裁决，不降低质量、引用数或预算。

## 6. 三栏 UI 与 anchor

输入为近期 confirmed 转写、建议 JSON、卡片和询问状态。执行现有 `npx tsx scripts/test-suggestion-anchor.ts`、`npx tsx scripts/test-desktop-event-mode.ts`；浏览器点击与布局需新增 `scripts/evaluate-three-column-ui.ts` 或 Playwright 用例后才能声称端到端通过。

观察并逐项断言：anchor 是近期转写子串；命中和未命中均有样本；未命中建议丢弃；点击标注会预填并聚焦询问框；左栏是转写/内联建议，中栏仅上下文卡片，右栏是 Live Ask，健康指标在设置区。SSR/纯函数只能证明数据语义，不能证明点击、焦点、视觉布局。

## 7. SQLite 持久化、刷新与 replay

输入包含新库、缺少新增列的旧库、非法 JSON、落库失败和服务重启。现有脚本：`npx tsx scripts/test-chat-store.ts`、`npx tsx scripts/test-session-store.ts`、`npx tsx scripts/validate-replay.ts`；跨页面刷新/replay 需新增 `scripts/test-replay-asks.ts`（待新增）。

观察 `sources`、`keywords`、`final_state`、`created_at`、旧库升级结果和恢复后的 UI。通过标准：旧库升级幂等、重复启动不重复 ALTER；合法数据刷新后完整恢复；非法 JSON/落库失败有本地可见终态且不阻塞实时链路；replay 显示询问、来源和降级标识。路由单测不能替代刷新和重启证据。

## 8. vault

执行 `npx tsx scripts/test-vault-exporter.ts` 和 `npx tsx scripts/test-export-training-data.ts` 的相关 fixture。逐档验证 `none/folded/full`、frontmatter、自描述 `transcript` 字段、重复导出字节一致、用户编辑保护、降级内容过滤和敏感字段过滤。`concepts/` 在三档均完整；meetings 转写遵守档位；trace、密钥、原始音频永不导出。未写入真实 vault 的 fixture 不能证明文件系统权限或用户编辑保护。

## 9. 只读 MCP

执行 `npx tsx scripts/test-mcp-server.ts`，真实 SQLite 查询另需授权库。覆盖工具零写路径、中文 FTS、分页游标、空结果、坏参数和错误终态。观察返回 schema、总数/游标、错误码和只读审计。通过标准：不暴露音频、密钥或原始 trace payload；分页不重复/不遗漏；错误可识别且不泄露内部路径。mock DB 不能证明真实索引性能。

## 10. 用户裁决与训练数据

执行 `npx tsx scripts/test-candidate-store.ts`、`npx tsx scripts/test-export-training-data.ts`。输入需区分人工确认、自动信号、时间顺序、双通道重复、短 term 和 session。通过标准：只有人工确认进入 DPO；自动信号仅候选；问题时间不早于候选时间；两个通道不重复；trim 后短于 2 字符不匹配；session 切分防泄漏；重复导出字节一致。导出必须只读且不含密钥、音频、原始 trace payload。fixture 不能证明人工操作本身，需 UI/审计端到端用例。

## 11. 统一异常矩阵与阶段归属

| 异常 | 阶段 1：性能/fail-closed | 阶段 3：隐私 | 阶段 6：端到端 |
|---|---|---|---|
| ASR 失败 | 延迟、终态、链路不崩 | 不适用 | 刷新/恢复后的数据一致性 |
| 关键词提取失败 | 性能与本地降级终态 | 零搜索、请求体审计、零转写外发 | 历史/总结/vault/训练过滤 |
| 搜索超时/失败 | 首事件、完成延迟、fail-closed | 仅验证外发字段 | 跨模块终态传播 |
| 来源少于 2 条 | 降级且不编造 | 不泄露正文 | 总结/vault/训练过滤 |
| schema 违规 | 终态与延迟 | 不适用 | replay/导出过滤 |
| 模型超时 | 完成失败率和恢复 | 不适用 | 服务重启、历史兼容 |
| 数据库写入失败 | 不阻塞实时链路的局部检查 | 不适用 | 重试、最终可见、恢复 |
| vault 写入失败 | 不适用 | 不适用 | 重试/报告/用户编辑保护 |
| 刷新和服务重启 | 服务健康和延迟影响 | 不适用 | session/replay/summarize/vault/MCP 恢复 |

阶段 3 专门验证隐私外发异常、关键词提取失败和请求体；阶段 6 执行落库、刷新/replay、总结、vault、训练导出和服务恢复的跨模块异常。不得以阶段 1 的 mock 或单路由测试替代阶段 6。

## 12. 发布前门禁与回滚

发布前依次执行：`npx tsc --noEmit`、`npm run lint`、停止 `:3000`、`npm run build`、恢复 `npm run dev` 并确认 `curl -I http://localhost:3000/` 为 200，再执行阶段脚本；模型/参数变更追加 `TMPDIR=/tmp npx tsx scripts/measure-ask-latency.ts`。同时确认 `:8082` health OK、暂存区无 `dataset/`/`.env`/模型文件、报告无密钥。

任何门禁失败、正常回答 P95 超预算、schema 非零、来源不足未降级或出现隐私越界时，停止发布，保留失败样本和版本 manifest，按部署文档回滚到上一已验证模型/配置；不得通过删样本、改分母、复制题集、降低预算或静默改决策来“修复”指标。
