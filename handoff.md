# CueMind 项目交接文档（handoff）

> **唯一开发入口：** `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md`
> **测评执行依据：** `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md`（负责“怎么测”）
> **当前阶段：** 阶段 1：P0 延迟稳定性收口。
>
> 8 题 × 3 轮已经完成，三轮均 8/8；第 2、3 轮是热缓存证据。扩展题集和性能异常属于阶段 1；隐私异常属于阶段 3；端到端异常属于阶段 6。服务当前保持关闭，启动前必须检查 `:8082/health` 和应用 health。

> **开发唯一入口：** [docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md](docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md)。后续开发、阶段状态、验收证据和新增内容统一写入该文档；本文仅用于接手导航和环境提示。

> 更新：2026-08-29（覆盖优化整改轮，基线提交 `ace5610` 之后；以 `git log -1` 为准）
> 读者：完全没有上下文的新会话 / 新接手者。接手顺序：本文 → `CLAUDE.md` → `AGENTS.md` → `README.md` → `docs/product/cuemind-grilling-decisions.md`（锁定决策）→ `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md` → `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md`。
> 仓库：`/home/work/asr/CueMind`，分支 `codex/local-realtime-meeting-copilot`（本地，未推送）。

CueMind 是**本地优先的实时会议认知副驾**：三栏界面（左=转写+建议内联标注，中=上下文卡片，右=会中询问），全链路本地生成，外发仅限搜索关键词。定位是面试项目（决策 1）：证明 10 分钟演示稳定、指标完整、工程取舍可解释。

```text
音频/视频 → 本地 whisper.cpp ASR → 候选窗口（confirmed 文本）
  → 本地 llama.cpp（Qwen3-8B，systemd :8082）关键词判断/询问关键词提取
  → 垂直源短路（arXiv/HN/GitHub/SO）+ Tavily/agent-reach 回退（仅外发关键词）
  → 引用式生成（JSON schema 校验，fail-closed）→ SSE 流式 → 三栏渲染
  → 落库（sessions/candidates/chat_messages）→ vault 导出 + MCP 只读暴露 + 离线训练数据导出
```

---

## 1. 已实现功能（Implemented Features）

状态标记：✅ 已交付并回归覆盖；🟡 已交付但存在已知残留（见第 2 节）。

### 1.1 实时转写链路

| 项 | 说明 |
|---|---|
| 麦克风实时转写 ✅ | 本地 whisper.cpp CLI per-request（1s tick、≥4s 节流、单飞）；`hooks/useMicRecorder.ts`、`lib/local-asr.ts`、API `app/api/local-transcribe/route.ts` |
| partial/confirmed 双级文本 🟡 | 首 partial 门限 2s + 4s 节流（决策 66 的 CLI 形态；完整 LocalAgreement-2 归 2.1b）；`lib/partial-transcript.ts` |
| 媒体上传离线转写 ✅ | `lib/upload-media.ts`、`lib/wav-slice.ts`、`app/api/upload-media/route.ts`、`components/MediaUploadPanel.tsx` |
| 转写润色 ✅ | `lib/transcript-polish.ts`（本地 provider，可选） |

### 1.2 上下文卡片（决策 26/候选账本）

| 项 | 说明 |
|---|---|
| 卡片管线 ✅ | `app/api/context-cards/route.ts`：关键词判断 → 搜索 → 卡片生成；7 类终态全落账 |
| 候选账本 ✅ | `lib/candidate-store.ts`（`candidates` 表：session/candidate/term/final_state/suppress_reason/card_id/created_at）；每术语一次、cooldown、重复抑制 |
| 卡片渲染 ✅ | `components/ContextCardsPanel.tsx`、`ContextCardView.tsx`（中栏仅卡片+失败态，决策 68） |
| 卡片「问更多」入口 ✅ | `termHint` 预填右栏询问框并聚焦（`98a3e8b`） |

### 1.3 会中询问（Live Ask，决策 67）✅/🟡

| 项 | 说明 |
|---|---|
| 询问路由 ✅ | `app/api/ask/route.ts`：关键词提取（≤1.5s 本地）→ 垂直源短路 + 通用回退（≤2 次）→ 引用式 JSON 生成 → schema 校验 fail-closed → SSE（`searching`/`answer_chunk`/`done`/`degraded`） |
| 询问让位 ✅ | 卡片生成在途时询问排队（红线 3）；`hooks/useAsk.ts` 单飞锁 |
| 搜索缓存 ✅ | `lib/ask-cache.ts`：term→results 短 TTL，卡片/询问单向共享 |
| 询问面板 ✅ | `components/AskPanel.tsx`（右栏；来源链接渲染、降级态、阶段进度） |
| 持久化 🟡 | 复用 `chat_messages` 表（`lib/chat-store.ts` + `/api/chat-messages`）；**仅存 role/content**——sources/keywords/终态丢失（路线图 P2） |
| 延迟 🟡 | 完成 P95 13032→7119ms（-45%），预算 7s 线 ±6% 噪声带内残留（路线图 P0 待裁决）；测量脚本 `scripts/measure-ask-latency.ts`（冻结题集 8 题） |

### 1.4 建议内联标注（决策 68）✅

- `SUGGESTIONS_PROMPT` 输出 `anchor`（近期转写子串 ≤12 字）；无锚点命中的建议丢弃；命中=大小写不敏感子串匹配。
- `lib/suggestion-anchor.ts`、`hooks/useSuggestions.ts`、`components/MicTranscript.tsx`（行内类别徽标，点击预填询问框）。

### 1.5 会话与总结

| 项 | 说明 |
|---|---|
| 会话持久化 ✅ | `lib/session-store.ts`（`sessions` 表）+ 浏览器自动保存 + 服务端 fire-and-forget 同步；`app/api/sessions/route.ts` |
| 会议总结 ✅ | `app/api/summarize/route.ts`；**纳入本次会话询问问答对**（`<meeting_asks>` 块，一行「问：…答：…」+ 截断保护；`eb90d12`） |
| 询问历史抽取 ✅ | `lib/ask-history.ts`：`extractAskExchanges`（跳过流式/降级/失败文案——`e7864eb`）+ `formatAskExchangesOneLine` |
| 会话标题 ✅ | `lib/session-title.ts`、`app/api/session-title/route.ts` |
| 回放页 🟡 | `app/replay/page.tsx`：转写+卡片回放；**不含询问历史渲染**（路线图 P2） |

### 1.6 知识沉淀（vault/MCP，决策 61/63）✅

| 项 | 说明 |
|---|---|
| vault 导出器 ✅ | `lib/vault-exporter.ts`：`meetings/`（不可变）+ `concepts/`（追加式）；frontmatter 契约（date/duration/input_source/asr_model/audio_hash/transcript/topic）；转写三档 `none\|folded\|full`（决策 64，默认 folded）；**「会中询问」小节**（问题+答案摘要+来源链接，none 档不导；`0a6eb72`） |
| 导出 API ✅ | `app/api/vault-export/route.ts`（meetings + concepts，幂等 upsert） |
| MCP 只读服务器 ✅ | `mcp-server/`（stdio）：`list_sessions`/`get_session`/`search_transcripts`(FTS5)/`search_cards`/`get_card`/`get_session_ledger`；零写路径 |

### 1.7 训练数据飞轮（决策 65）✅/🟡

- `scripts/export-training-data.ts`：纯离线只读（`readonly: true`）→ SFT 指令对（窗口文本→关键词判断）+ DPO 偏好对：
  - 通道一：`--useful` 人工标记（人工把关）；
  - 通道二 🟡：会中询问命中（自动信号；`1ab4849`）——与「人工把关」红线存在**已留痕的显式偏差**（决策 65 变更记录），根治归路线图 P4。
- 失败模式统计（7 终态固定键序）+ 会中询问信号统计（漏报 DPO / 卡片解释质量不足）；按 session 切分防泄漏（sha256 首字节 %5）；字节级幂等。

### 1.8 模型基线与部署 ✅

- **当前基线：Qwen3-8B-Q4_K_M**（2026-08-29 由 4B A/B 切换；触发 F1 与 schema 合法率持平、卡片 P95 3628→3080ms、询问首字节 926→599ms、显存 6422MiB ≤ 7.5GB）。
- systemd 服务：`/etc/systemd/system/cuemind-llama.service` → `llama-server -m /home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf --host 127.0.0.1 --port 8082 -c 8192 -ngl 99 -fa on --jinja --reasoning off`；健康检查 `curl http://127.0.0.1:8082/health`。
- 部署文档：`docs/deployment/qwen3-4b-llama-cpp.md`（§16.4 A/B 计划、§16.5 基线切换记录含 sha256 与回退方法）；A/B 报告 `/home/work/reports/cuemind/model-ab-2026-08-29.md`。
- GPU：RTX 4060 Ti 8GB（WSL2）；测量一律 GPU（`-ngl 99`），不用 CPU 数冒充基线。

### 1.9 回归测试矩阵（`scripts/test-*.ts`，全部可离线跑）

- 询问：`test-ask-route.ts`（来源≥2/降级/schema 违规/缓存/隐私/termHint 兜底/askPrompt 迁移）
- 并发：`test-ask-card-concurrency.ts`（询问让位不回退卡片）
- 总结：`test-summarize-route.ts`（含降级过滤用例 e）
- 导出：`test-vault-exporter.ts`（三档+会中询问小节）、`test-export-training-data.ts`（双信号/幂等/切分/无密钥）
- 卡片/账本/锚点/转写等：`test-context-card-route.ts`、`test-candidate-store.ts`、`test-suggestion-anchor.ts`、`test-partial-transcript.ts`、`test-session-store.ts`、`test-chat-store.ts`、`test-mcp-server.ts` 等

**门禁（每笔提交必过）**：`npx tsc --noEmit` → `npm run lint` → 停 `:3000` → `npm run build` → 恢复 `npm run dev` 并确认 200。已知历史遗留：`lib/partial-transcript.ts:63` `_state` unused warning（路线图 P5）。

---

## 2. 未实现功能（Unimplemented Features）

优先级依据 `docs/plans/2026-08-29-cuemind-optimization-roadmap.md`；工作量用相对档 S（≤1 个文件级改动）/ M（跨 2–4 模块）/ L（≥5 模块或含架构决策）。

| # | 事项 | 优先级 | 依赖 | 工作量 | 说明 |
|---|---|---|---|---|---|
| U1 | P0 延迟残留裁决 | **高** | 无 | S（仅决策+文档）或 L（架构改造） | 完成 P95 7119ms > 7s 预算（±6% 噪声带）。三选一：修订决策 67 预算口径 / 继续压答案质量 / 硬件手段（投机解码、量化、升级）。**须用户裁决，不得静默实施** |
| U2 | P2 询问持久化完整性 | 高 | 无 | M | `chat_messages` 增列 `sources_json`/`keywords_json`/`final_state`（PRAGMA 检测 + ALTER，不迁移旧数据）；前端透传；`/replay` 渲染询问历史；训练导出改读真实提取词 |
| U3 | P4 漏报裁决入口 | 高 | U2 | M | 卡片侧「该词应出卡」用户确认入口，打通决策 65 人工把关；自动命中降为候选，确认后才进 DPO |
| U4 | P3 训练信号严谨化 | 中 | U2（提取词部分） | M | 时序约束（问题时间 ≥ 候选 created_at）、双通道去重（--useful 优先）、term <2 字符不匹配 |
| U5 | 隐私降级口根治 | 中 | 无 | S | 关键词提取失败时兜底外发问题前 20 字（`app/api/ask/route.ts`）→ 改为不发起搜索；对齐「外发仅关键词」红线 |
| U6 | P5 落库可靠性 | 中 | 无 | S | 询问落库失败重试（≤3 次退避）+ 失败可见，替代 fire-and-forget |
| U7 | 失败模式可见 | 低 | U2 | M | 设置健康区展示询问降级率/来源不足率/近 20 次完成延迟（本地统计） |
| U8 | 端到端用例补齐 | 低 | 无 | M | replay 含询问历史、summarize 前端传参链路（当前只测路由纯函数层） |
| U9 | MCP `list_asks(session_id)` | 低（远期） | U2 | S | live-ask 计划 B 阶段遗留项 |
| U10 | partial 完整方案（2.1b） | 低 | 常驻 whisper 进程 | L | LocalAgreement-2 + 增量前缀提交；本期验收口径已调整（决策 66 变更记录） |
| U11 | 主动问题检测 | **不做** | — | — | 决策 67 红线：仅手动触发 |
| U12 | 云端知识工具（飞书/Notion） | **不做** | — | — | 决策 63：vault 是唯一沉淀目的地 |

**仓库卫生欠账（P5）**：未跟踪 `AGENTS.md` 待提交；`dataset/` 永不入库；`CLAUDE.md`/`README.md`/部署文档工作区有未提交改动（责任人各自处理）；清理 `_state` warning。

---

## 3. 后续步骤（Follow-up Steps）

阶段按依赖排序，不给时间承诺；每阶段有独立验收。

### 阶段 0：环境就绪（每次新会话先做）

1. `cd /home/work/asr/CueMind`（**不要在 `/home/work/asr` 跑 git**）。
2. 检查模型服务：`curl -s http://127.0.0.1:8082/health` 应为 `{"status":"ok"}`；不在则 `sudo systemctl start cuemind-llama`（沙箱无权限时用 `systemd-run` 在沙箱外执行）。
3. 启动应用：`npm run dev` → `curl -I http://localhost:3000/` 应 200。
4. 快速回归：`npx tsx scripts/test-ask-route.ts && npx tsx scripts/test-summarize-route.ts`。

### 阶段 1：U1 延迟裁决（阻塞后续叙事）

- 任务：复跑 `npx tsx scripts/measure-ask-latency.ts` 确认现状 → 提交三选一裁决（见 U1）→ 按裁决落文档或代码。
- 责任：裁决归用户；执行归开发会话。
- 成功标准：决策文档出现对应变更记录（口径修订或修复方案）；若修代码，冻结题集复测数据写入路线图。

### 阶段 2：U2 持久化完整性（后续多项的前置）

- 任务：表增列 + 路由/前端透传 + replay 渲染 + 训练导出读真实提取词。
- 成功标准：刷新页面后询问历史含来源与终态；`test-chat-store.ts`/`test-export-training-data.ts` 新增用例全绿；旧库启动幂等（重复启动不重复 ALTER）。

### 阶段 3：U3 + U4 数据飞轮闭环

- 任务：漏报裁决入口（用户确认才进训练）+ 信号严谨化（时序/去重/阈值）。
- 成功标准：裁决 → 导出端到端用例通过；决策 65 变更记录中「人工把关偏差」可标记为已根治。

### 阶段 4：U5–U10 与卫生收尾

- 按第 2 节表格逐项推进；每项独立提交、独立过门禁。
- 最终成功标准：`npm run lint` 零 warning；路线图全部条目的状态列更新；`git status` 仅剩 `dataset/` 未跟踪。

### 贯穿纪律

- 一次只做一个阶段；遇到计划未覆盖的决策点**先停下来问**。
- 每笔提交过完整门禁（build 前停 `:3000`，提交后恢复并验证 200）。
- 报告不虚标：fixture/mock 证据必须保留 evidence boundary；未验证不得声称完成。

---

## 4. 环境与运维要点

- **沙箱限制**：Trae 沙箱不能写 `/home/work/models`、`/home/work/reports`、`/etc/systemd/system`；特权操作走 `systemd-run --collect --wait --property=Type=oneshot ...`（沙箱外执行）。
- **端口**：应用 `:3000`（dev，build 前必须停）；llama-server `:8082`（systemd 托管，勿手杀）。杀 dev 残留用 `pkill -TERM -f '[n]ext-server'`；**杀 llama 用 `pkill -x llama-server`，禁用 `pkill -f "build/bin/llama-server"`**（会误杀当前 shell）。
- **数据目录**：`CUEMIND_DATA_DIR`（默认 `<cwd>/.data`），`cuemind.db`（better-sqlite3 WAL）；chat-store 原生模块失败时降级 JSONL。
- **密钥**：仓库根 `.env`（TAVILY_API_KEY 等）——只可检查存在性，永不打印、永不入库、永不进报告。
- **模型文件**：`/home/work/models/cuemind/`，永不 `git add`；sha256 记录见部署文档 §16.5 与同目录 `.sha256` 文件。

## 5. 红线与禁止重犯项

1. **实时链路零侵入**：询问/导出/训练脚本只读实时链路产物，不改转写/卡片行为。
2. **外发最小化**：仅问题+关键词出机器；已知例外（提取失败兜底前 20 字）已在决策 67 变更记录声明，根治前列入对外叙事例外。
3. **不编造**：来源 <2 降级、schema 违规终态、fail-closed；宁可漏一张好卡，不出一张错卡（决策 4）。
4. **不在 `/home/work/asr` 跑 git**；不 `git add dataset/`；不打印密钥；不把 mock/fixture 当真实评估。
5. **不静默覆盖决策历史**：决策文档只追加变更记录（持续记录规则第 4 条）。
6. **纯离线导出**：训练导出只读打开库；不建文件、不写库、不含密钥/音频。
7. **未验证不声称完成**：提交、门禁、服务可用都必须有本轮命令输出为证。

## 6. 关键文档索引

| 文档 | 用途 |
|---|---|
| `docs/product/cuemind-grilling-decisions.md` | 68 道锁定决策 + 变更记录（最高产品权威） |
| `docs/plans/2026-08-29-cuemind-optimization-roadmap.md` | 当前整改路线图 P0–P5（**接手后第一行动依据**） |
| `docs/plans/2026-08-28-cuemind-live-ask-plan.md` | 会中询问 A/B/C 阶段设计与验收契约 |
| `docs/deployment/qwen3-4b-llama-cpp.md` | llama.cpp 部署 + A/B 计划 + 基线切换记录 |
| `docs/plans/2026-08-27-cuemind-knowledge-export-mcp-plan.md` | vault/MCP 主线计划（未跟踪，待提交） |
| `reports/` | 各轮评估产物（context-card/provider/replay/A-B） |

---

## 7. 交接提示词（用于告知新会话）

将以下内容作为新会话的首条消息即可建立完整上下文：

```text
你接手 CueMind 项目（本地优先实时会议认知副驾，面试项目定位）。

仓库：/home/work/asr/CueMind，分支 codex/local-realtime-meeting-copilot（本地未推送；用 git log -1 确认当前位置）。
先进入 `/home/work/asr/CueMind`，优先读取：`handoff.md` → `CLAUDE.md` → `docs/product/cuemind-grilling-decisions.md`（锁定决策 68 道，只追加变更记录，不覆盖）→ `docs/plans/CUEMIND-MASTER-DEVELOPMENT-PLAN.md`（唯一开发入口）→ `docs/plans/CUEMIND-EVALUATION-IMPLEMENTATION-GUIDE.md`（测评执行依据）；旧路线图仅作历史整改依据。

技术栈：Next.js 15 App Router + React 19 + TS；本地 llama.cpp（Qwen3-8B Q4_K_M，systemd cuemind-llama.service，:8082，勿手杀）；本地 whisper.cpp ASR；better-sqlite3（CUEMIND_DATA_DIR/cuemind.db，WAL）。

现状速览：三栏 UI（转写+锚点标注 / 上下文卡片 / 会中询问）全部可用；会中询问=关键词提取→垂直源短路+回退→引用式生成→fail-closed SSE；vault 导出（三档转写开关）+ 只读 MCP + 离线训练数据导出（SFT/DPO 双通道）已交付；回归测试在 scripts/test-*.ts。

硬红线：实时链路零侵入；外发仅问题+关键词（已知例外：提取失败兜底前 20 字，决策 67 变更记录已声明）；来源<2 降级不编造；纯离线导出只读；永不 git add dataset/、永不打印 .env 密钥、不在 /home/work/asr 跑 git；每笔提交过门禁（tsc→lint→build，build 前停 :3000，事后恢复并验证 200）。

当前待办：阶段 1 扩展题集（至少 30-50 题，需授权）与性能异常矩阵；延迟残留裁决（完成 P95 7119ms vs 预算 7s，须用户裁决三选一）。阶段 2 起再处理持久化、裁决、训练信号和隐私/端到端异常。

环境坑：沙箱写不了 /home/work/models、/home/work/reports、/etc/systemd（用 systemd-run 在沙箱外执行）；:3000 常有 next-server 残留（pkill -TERM -f '[n]ext-server'）；lint 有一个已知历史 warning（partial-transcript.ts _state）。

纪律：一次只做一个阶段；计划未覆盖的决策点先停下来问；报告不虚标（mock 证据保留 evidence boundary）；未验证不声称完成。
```
