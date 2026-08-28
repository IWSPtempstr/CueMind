# CueMind 落地总规划（Master Plan）

> 日期：2026-08-27（2026-08-28 增补：第二规划期四条主线，依据决策 61–65）
> 状态：P0–P5 第一规划期执行中；第二规划期（主线一至四）待排期
> 来源：用户 5 项反馈需求 + 前置风险修复合并规划；第二规划期来自知识沉淀/竞品/缺口三轮调研
> 决策依据：`docs/product/cuemind-grilling-decisions.md`（问题 56–65）与 `2026-08-27-cuemind-knowledge-export-mcp-plan.md`

## 一、背景与目标

将项目从「面试演示 MVP」推进到「真实可落地产品」。本规划合并两条线：

1. **P0 前置**：前序改造（本地 provider 切换 / 流式上传 / 健康面板）遗留的 5 项技术风险修复。
2. **P1–P4 用户需求**：会话选择增强、追问服务端化、桌面双轨输入源、转写质量提升。
3. **P5**：测试、验收、部署与版本规划。

目标版本：`v0.2.0`（P0–P2，网页端完整可用）、`v0.3.0`（P3–P4，桌面双轨 + 转写质量）。

## 二、本轮 Grilling 锁定决策（问题 56–60）

| # | 问题 | 决策 | 关键含义 |
|---|---|---|---|
| 56 | 会后追问数据存哪 | **服务端 SQLite + 抽屉保留** | 部分替代决策 12 的 IndexedDB 路线（仅限聊天追问数据；知识库决策不变）。提供 REST API 支持后续功能 |
| 57 | ASR 升级路径 | **large-v3-turbo Q5**（~575MB） | 已核实 whisper-cli 为纯 CPU 构建（无 CUDA），medium 在 CPU 上 RTF≈1.0 慢于实时会积压；turbo Q5 准确度≈large-v3 且 CPU RTF≈0.3–0.5，双模式可用，原生输出标点 |
| 58 | 系统音频捕获 | **Windows 桌面双轨** | 沿用决策 2「部分完成项」边界：WSL 环境无法实机验收，交付代码 + 单测 + 显式「未实机验收」标注 |
| 59 | 会话主题摘要时机 | **会议结束时生成** | 本地 llama 生成 ≤20 字主题；生成前/失败时降级为首句截断 |
| 60 | 与风险修复的关系 | **合并为本总规划** | 风险修复作为 P0 前置阶段，全部实施 |

## 三、路线图与排期（单人项目，按人日，角色以帽子映射）

| 阶段 | 内容 | 人日 | 角色（帽子） |
|---|---|---|---|
| P0 | 风险修复（R1/R2/R4/R5/R6 + 环境规范） | 1.0 | 后端 |
| P1 | 会话选择增强（主题摘要 + 下拉格式） | 0.5 | 前端 + 后端 |
| P2 | 追问服务端化（SQLite + API + 迁移） | 1.0 | 后端 + 前端 |
| P3 | 桌面双轨输入源控制（模式选择 + 混音 + UI 状态） | 1.5 | 桌面(C#) + 前端 |
| P4 | 转写质量（turbo Q5 + 麦克风本地化 + 分段 + 术语库 + Groq 清理） | 1.5 | 后端 + 前端 + UI |
| P5 | 测试验收 + 打包 + 版本发布 | 0.5 | 测试 + 交付 |
| **合计** | | **6.0 人日** | |

依赖关系：P0 无依赖可立即开始；P1 依赖 P0（摘要路由走本地 provider 已就绪）；P2 独立；P3 依赖 P4 的模型配置（桌面转写共用 whisper 设置）；P5 收尾。

## 四、P0：风险修复（前置）

### R1 chat 流空闲看门狗
- **文件**：`app/api/chat/route.ts`
- **现状**：固定 `AbortSignal.timeout(60_000)`，长回复整流必断。
- **方案**：改自建 AbortController + 30s 空闲计时器——每收到 upstream SSE chunk 即重置；空闲到点才 abort 并透传 502「llama.cpp provider timed out」；客户端取消（request.signal）静默关流。对客户端 SSE 输出格式零变化。

### R2 abort 即刻杀死 whisper 子进程
- **文件**：`lib/local-asr.ts`、`lib/upload-media.ts`、`app/api/upload-media/route.ts`
- **方案**：`LocalAsrRequest` 增加可选 `signal`；`runProcess` 监听 abort → `child.kill()` 并 reject；`processUploadStreaming` 把 `options.signal` 传入每窗转写。效果：取消后数百毫秒内子进程死亡、临时目录清理，不再等满一窗（≤60s）。

### R4 流式失败上屏
- **文件**：`hooks/useMediaUploader.ts`
- **方案**：`processOneFile` 的 rejected 分支调用 `setError(message)`（cancelled 保持静默）；`consumeSseText` 解析到 error 事件当下即上屏。MediaUploadPanel 已有错误渲染与「忽略」按钮，UI 零改动。

### R5 无音轨友好提示
- **文件**：`lib/local-asr.ts`
- **方案**：ffmpeg 失败分类处识别 stderr 模式 `/does not contain any stream|matches no streams|Stream map/i` → 错误消息改为「该文件没有可用的音频轨道，无法进行语音转写」+ 原始摘要。`scripts/test-media-asr.ts` 新增对应用例。

### R6 WAV 切片流式化
- **文件**：`lib/wav-slice.ts`
- **方案**：`sliceWavToWindowFiles` 改 `fs.open` + 4 MiB 块顺序读写，内存从 O(整文件) 降为 O(窗口)。对外签名与字节一致性断言不变。

### R7 环境规范固化
- **文件**：`CLAUDE.md`、`README.md`
- **方案**：追加「`npm run build` 前必须停 :3000 dev server（turbopack 与 build 共写 `.next` 会产物损坏 ENOENT）」约定；progress.md 记录三次事故处置结论。

## 五、P1：会话选择增强

### 数据结构
- `types/session.ts`：`SessionSnapshot` 增加 `topicSummary?: string`。
- `lib/session-storage.ts`：revive 透传新字段（`MAX_SAVED_SESSIONS = 10` 保持不变）。

### 主题摘要生成
- **新路由** `app/api/session-title/route.ts`：POST `{ transcript: string }` → 复用 `lib/llama-cpp.ts` 的 `resolveLocalProvider` + `generateLlamaCppJson`；系统提示：「从会议转写中提取讨论主题，输出不超过 20 个中文字符的主题短语，只返回 JSON {"topic":"..."}」；超时 8s。
- **触发时机**（决策 59）：
  1. `app/page.tsx` 的 `handleRecordingChange(false)` 流程：与会议总结（`/api/summarize`）并行发起，互不阻塞；
  2. 上传 done 后：会话 ≥3 个转写块且无 topicSummary 时触发一次（去重 ref 防重复）。
- **降级**：生成失败/未完成时沿用现有 `sessionTitle()` 首句截断逻辑（`app/page.tsx` L24–27），不阻塞任何主流程。

### 下拉格式
- `app/page.tsx` header 会话选择器选项文案改为：`[YYYY-MM-DD] - [主题]`。
  - 主题 = `topicSummary`（≤20 字），缺失时降级为首句截断。
  - 日期 = `createdAt` 格式化 `YYYY-MM-DD`（padStart 补零）。

## 六、P2：追问服务端化（SQLite）

### 存储层
- **依赖**：`better-sqlite3`（需 `package.json` 新增 + `next.config.ts` 配置 `serverExternalPackages: ["better-sqlite3"]`）。
- **新模块** `lib/chat-store.ts`：初始化 `.data/cuemind.db`（目录加入 `.gitignore`；WAL 模式），表结构：
  ```sql
  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    is_detail INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, created_at);
  ```
- 兜底：若 better-sqlite3 原生模块在 WSL 构建失败，`chat-store` 以接口抽象降级 JSONL 文件实现（同一 API 面）。

### API
- **新路由** `app/api/chat-messages/route.ts`：
  - `GET ?sessionId=xxx` → 按时间升序返回该会话全部追问消息；
  - `POST { sessionId, messages: [...] }` → 批量写入（幂等，按 id upsert）。

### 前端接线（`hooks/useChat.ts` + `app/page.tsx`）
- `sendMessage` / `addSuggestionToChat` 消息落定后（含流结束、失败终态）POST 持久化；
- 抽屉（`components/ChatPanelDrawer.tsx`）打开时按 activeSessionId GET 拉取；
- `SessionSnapshot.chatMessages` 停止写入 localStorage（新数据仅存服务端）；旧会话首次打开抽屉时检测服务端无数据 → 懒迁移一次性 POST；
- 会话切换/新建时从 API 重建内存态。

### 决策记录
- 本项部分替代 grilling 决策 12（仅聊天追问数据改服务端 SQLite；知识库 IndexedDB 决策保留不变），已在决策文档问题 56 注明替代关系。

## 七、P3：桌面双轨输入源控制

### 现状事实（已核查）
- `native/CueMind.Audio/AudioCaptureService.cs`：**系统（WasapiLoopbackCapture）+ 麦克风（WasapiCapture）双轨道已实现**，每 5s 出块，静音过滤；
- `desktop/electron/main.ts`：helper 进程管理、事件桥（`desktop:event`）、IPC（`runtime:*`）已就绪；
- `hooks/useDesktopTranscript.ts`：消费 `audio_chunk_ready`（含 source）→ `/api/local-transcribe`；
- 缺口：**两轨道恒同时采集，无模式选择；UI 无输入源指示**。

### 改动
1. **C# 模式参数**：`AudioCaptureService.StartAsync` 接受 `--sources mic|system|mixed`（默认 mixed 保持现状）；非选中轨道不创建 TrackCapture。Program 入口解析 argv。
2. **Electron main**：`runtime:start-audio-helper` IPC 增加 `sources` 参数透传 spawn args；模式切换 = 重启 helper。
3. **preload 桥**：`cuemindDesktop.setAudioSourceMode(mode)` 新 API（`desktop/electron/preload.ts` + `types.ts`）。
4. **前端 hook**：`useDesktopTranscript` 增加输入源模式 state；start 前调用 setAudioSourceMode；`types/session.ts` 的 AudioSource 不变（system/microphone 已存在）。
5. **UI**：
   - `components/MicTranscript.tsx`：isDesktop 时显示三态选择器（仅麦克风 / 仅系统 / 混合），非桌面模式隐藏；
   - `components/HealthPanel.tsx`：ASR 状态块显示当前输入源模式 + 双轨各自的活跃状态。
6. **混音语义**：mixed 模式 = 双轨并行采集、转写结果按时间戳排序合并（现有行为），不做 PCM 层混流（保留来源可追溯性，且避免有损混音）。

### 验收边界（决策 58）
- WSL 无法运行 Windows helper → 本阶段交付：代码 + 纯函数单测（新增 `scripts/test-desktop-event-mode.ts` 覆盖事件解析与模式参数序列化）+ `desktop-mvp.md` 显式标注「Windows 双轨未实机验收」。
- 不宣称闭环（遵循决策 2 边界）。

## 八、P4：转写质量提升

### 4.1 模型升级（决策 57）
- 下载 `ggml-large-v3-turbo-q5_0.bin`（~575MB）至 `/home/work/asr/.runtime/models/`（HF 直连失败时用 hf-mirror.com 镜像）；
- `hooks/useSettings.ts` 默认 `localWhisperModelPath` 切换至新模型；设置面板更新模型说明文案；
- **性能验证**：用 150s 冻结片段实测 RTF，目标 ≤0.6（small 基线 0.43）；不达标可经设置切回 small（模型路径即配置，天然支持）。

### 4.2 麦克风转写本地化（承接前序已确认决策）
- `hooks/useMicRecorder.ts` 的 `transcribeBlob`：改 POST `/api/upload-media`（非流式 JSON 路径，webm 在白名单），字段含 whisper 配置；响应 `chunks[].text` 合并为该段转写，source 保持 `"microphone"`；
- 重试/静音过滤/分片轮换机制原样保留；缺失 whisper 配置时给出明确提示。

### 4.3 Groq 残留清理
- `components/SettingsModal.tsx`：删除 Groq Key 输入框、Test key 按钮（L101–118 的 validate-key fetch）、相关提示文案；
- 删除无调用方路由：`app/api/transcribe/route.ts`、`app/api/validate-key/route.ts`、`lib/groq-route-helpers.ts`；
- `hooks/useSettings.ts` 移除 `groqApiKey` 字段与 `groqRequestHeaders`（useChat/useSuggestions/useMicRecorder 调用点同步简化）；
- `.env` 的 GROQ_API_KEY 由用户自行清理（代码不再读取）。

### 4.4 智能分段
- turbo 模型原生输出标点（small 中文无标点是主因之一），句内可读性自动改善；
- 段落划分：`components/MicTranscript.tsx` 渲染层按相邻 chunk 时间差判断——`startMs[i] - endMs[i-1] > 800ms` 则插入段落间距（上传/麦克风/桌面三条链路的 chunk 均已带 startMs/endMs）；纯数据驱动，不改存储结构。

### 4.5 专业术语库
- `types/settings.ts` + `SettingsModal`：新增 `domainGlossary` 文本域（逗号分隔术语）；
- `lib/local-asr.ts`：`transcribeWithWhisperCpp` 在 glossary 非空时追加 `--prompt "术语1，术语2，…"`（whisper 初始提示偏置）。

### WER 验收边界
- 无人工标注基准集（决策 57：主观验收）。文档记录证据边界：**不宣称任何 WER 数值**；验收方式为 150s 冻结片段转写人工通读比对 + 标点/分段可读性检查。

## 九、P5：测试计划与验收标准

### 功能测试（回归脚本）
- 现有 8 个脚本全绿（test-model-providers / test-context-card-route / test-end-to-end-evaluator / test-demo-windowing / test-demo-ledger / test-local-asr / test-media-asr / test-media-upload-route）；
- 新增：`test-session-title-route.ts`（摘要路由含降级）、`test-chat-store.ts`（SQLite CRUD + 幂等 upsert + 按会话隔离）、`test-desktop-event-mode.ts`（P3 模式参数）、R5 无音轨用例（并入 test-media-asr）。

### 性能测试
| 指标 | 目标 | 测法 |
|---|---|---|
| turbo RTF | ≤0.6 | 150s 冻结片段实测（对照 small 基线 0.43） |
| 上传流式逐窗延迟 | 单窗 ≤20s | SSE 时序（已有验证模式） |
| 卡片链路 P95 | ≤8s（决策 25 目标线） | 现有 latencySamples 统计 |
| chat 空闲超时 | 30s 空闲触发、活跃流不中断 | mock upstream 慢流用例 |

### 浏览器 UX 冒烟清单
- 会话下拉显示 `[YYYY-MM-DD] - 主题`；无主题降级样式；
- 追问跨刷新持久（刷新后抽屉重开能拉回历史）；旧 localStorage 会话懒迁移；
- 上传失败（无音轨文件）错误可见可忽略；取消上传即刻停止；
- 转写有标点、按段落分组渲染；术语偏置生效（含术语的片段识别改善）；
- HealthPanel 输入源状态正确（网页模式 / 桌面模式）。

### 用户体验测试
- 三条链路各跑一遍 10 分钟素材：麦克风实时（本地）、上传视频、（有条件时）桌面双轨；
- 记录：转写滞后感受、卡片打扰度、健康面板信息可读性。

## 十、部署策略与版本规划

| 环境 | 定义 | 流程 |
|---|---|---|
| 开发 | WSL dev server（:3000 + llama-server :8082） | 当前流程；遵守「build 前停 dev」规范 |
| 测试 | 静态门禁 + 回归套件 + 冻结 replay 评估 | tsc/lint/build → 全部脚本 → 浏览器冒烟清单 |
| 生产/演示 | v0.2.0：网页端完整能力；v0.3.0：+ 桌面双轨 | Electron standalone（`desktop/prepare-standalone.mjs` 打包，Windows 双轨标注未实机验收） |

版本节奏：
- **v0.2.0**（P0–P2 完成）：风险修复 + 会话增强 + 追问持久化；提交序列按阶段独立 commit；
- **v0.3.0**（P3–P5 完成）：桌面输入源控制 + turbo 转写质量 + 全量验收报告。

## 十一、风险评估与应对

| # | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| 1 | turbo 模型下载失败（网络） | 中 | P4 阻塞 | hf-mirror.com 镜像；设置项可切回 small，配置层面天然回退 |
| 2 | turbo RTF 实测 >0.6 | 低 | 实时性退化 | 模型路径配置化直接切回 small；预留 CUDA 重编译选项（后续） |
| 3 | better-sqlite3 原生构建失败 | 中 | P2 阻塞 | chat-store 接口抽象 + JSONL 文件实现兜底，API 面不变 |
| 4 | Windows 双轨无法实机验收 | 确定 | P3 验收受限 | 决策 58 已锁定：交付代码 + 单测 + 显式标注，不宣称闭环 |
| 5 | llama 并发压力（chat+卡片+标题同场） | 低 | 延迟上升 | llama-server 多 slot 支持并发；实测验证，必要时前端串行队列 |
| 6 | P2 与决策 12 架构冲突 | 已消解 | — | 决策 56 已记录替代关系（仅聊天数据服务端化，知识库决策不变） |
| 7 | 旧会话 chat 数据迁移丢数据 | 低 | 用户可感知 | 懒迁移幂等 upsert + 迁移前 localStorage 数据不删除（双写期只读兼容） |
| 8 | 8GB 显存与 llama-server 共存（若启用 CUDA） | 低 | OOM | 本期不启用 CUDA；预留选项并注明显存约束 |

## 十二、执行顺序与提交划分

```
P0 (1d)  → commit: fix: harden streaming timeouts, cancellation and error surfacing
P1 (0.5d) → commit: feat: session topic summaries in session picker
P2 (1d)  → commit: feat: persist post-meeting Q&A to server-side SQLite store
P3 (1.5d) → commit: feat: desktop dual-track audio source mode control
P4 (1.5d) → commit: feat: upgrade ASR to turbo q5 with segmentation and glossary
           commit: refactor: drop remaining Groq dependencies
P5 (0.5d) → 验收报告 + progress.md/task_plan.md 记录
```

每阶段提交前门禁：`npx tsc --noEmit && npm run lint && npm run build`（停 dev server）+ 相关回归脚本全绿。

---

# 第二规划期：四条主线（2026-08-28 增补）

> 原则：**先修体验（实时性），再补数据闭环（训练侧），最后做分发（安装包）。** 管线正确性已被 8 轮回归验证，本规划期补的是「真实用户前 10 分钟」的能力；可分发性（主线三）延后至主线五之后（用户裁决 2026-08-28）。
> 依据：决策 61（vault 沉淀）、62（MCP server）、63（不接云端端点）、64（转写导出三档）、65（离线训练数据闭环）；缺口调研（partial 转写/说话人归属/可分发性）。

## 主线一：知识沉淀闭环（决策 61/62/64）

详细实施契约见 `2026-08-27-cuemind-knowledge-export-mcp-plan.md`（该文档为唯一事实源，此处仅编排列位）。

| 步骤 | 内容 | 状态 |
|---|---|---|
| M1 | stdio MCP server + 服务端会话持久化 | ✅ 已完成验收 |
| M2 | 候选账本落库 + MCP 三工具（search_cards/get_card/get_session_ledger） | ✅ 已完成验收 |
| M3 | vault 导出器（meetings/ + concepts/ + 转写三档开关 + 目录名自定义）+ MCP 合流读取 | 待实施 |
| ~~M4~~ | ~~飞书 sink 抽象~~ | **已取消（决策 63）** |

前置条件：M3 开工前确认转写三档开关（决策 64）与设置项（`exportTranscript`/`vaultExportDirName` 已入 Settings 体系）已写入——已完成（2026-08-28）。

## 主线二：实时体验补课（M3 后立即启动）

竞品（Otter 实时字幕 / Granola 会后 10-15s）已全面解决而 CueMind 缺失的部分，优先级高于一切新功能。

### 2.1 Partial 转写中间反馈（体验分水岭）

- **问题**：8-12s 候选窗口闭合后才有已确认文本，真实会议里用户盯着空屏最长 10 秒。
- **方案**（LocalAgreement-2，学术验证 3.3s 延迟）：
  - 窗口内多次增量重转写，连续两次解码前缀一致即提交为已确认文本，其余作为 partial 展示；
  - 静音早终结：检测 ~120ms 静音立即 finalize（TTCT < 100ms）；
  - 与现有架构契合点：2 秒重叠上下文与停顿闭合逻辑已覆盖半个方案，缺的是 partial 发射通道（`useTranscriptionLoop` 增量比对 + UI 左栏 partial 态样式）。
- **验收**：partial 文本出现延迟 ≤2s；确认文本与现有整窗转写一致性抽检；卡片链路 P95 不回退。
- 参照：whisper_streaming（ufal）/ StreamSSN（CPU 自适应流式，INT8 6-8x 实时先例）。

#### 2.1b（候选，另立迭代）：LocalAgreement-2 完整方案

2.1 已落地 CLI per-request 形态（首现 ~3s，两段式时序），受限于每次请求重开进程 + 模型加载。**2.1b 交付真正的 ≤2s**：
- **常驻 whisper 进程**（消除每请求 ~1s 模型加载），或升级为流式解码；
- **增量前缀提交**（LocalAgreement-2）：连续两次增量解码前缀一致即提交，配合静音早终结；
- **验收**：partial 首现 ≤2s（真机麦克风实测记录在案），一致性抽检 ≥99%，卡片 P95 不回退；
- 立项前置：另立版本化设计 + 决策文档追加条目（决策 66 变更记录已预留）。

### 2.2 双通道说话人归属

- **方案**：复用决策 58 的 Windows 双轨 WASAPI 采集，按通道能量打 YOU/REMOTE 角色标签——零模型成本，纯 DSP。
- **明确不做**：pyannote 云端流式 diarization（音频上云违反 local-first）；本地 pyannote 批量（需 GPU，仅远期会后处理可选）。
- **验收**：双轨窗口文本带 speaker 标签；单轨模式（麦克风/上传）无回归。
- 依赖：P3 桌面双轨输入源控制（第一规划期）完成。
- **进度（2026-08-28）**：纯函数 + 单测 + hook 接线已交付；C# 已透出 `energy` 字段（窗口峰值 RMS）→ 泄漏跟随全链路激活；旧版 helper 无 energy 自动退化为通道映射。WSL 无法运行 Windows helper → 不宣称实机验收闭环（决策 58 边界，交付代码 + 单测 + 显式标注）。

### 2.3 长会话加固

- 滚动 buffer 只留 10s 尾部（防大文件内存占用——已知风险清单项）；
- 模型预热（首段 dummy 音频，消除首窗延迟尖刺）；
- whisper.cpp `--prompt` 注入术语表（与 P4.5 domainGlossary 汇合，一箭双雕）。

## 主线三：可分发性（真实用户前必经）

- **Tauri 壳内嵌 Next.js server**（Granola 同款「本地 server + 桌面壳」结构；现有 Electron 桌面壳为决策 58 双轨服务，二者关系需在立项时裁决：复用 Electron 还是迁移 Tauri）；
- **首跑向导**：检测/按需下载 whisper GGML 模型 → 拉起 llama-server → 健康检查（复用 HealthPanel 指标为 onboarding 检查项）；
- 解冻 demo-design 排除第 10 条「生产级 Windows 交付」，按决策文档规则另立版本化设计（本条即为该设计入口）；
- 远期可选：读本地 .ics 日历，会议开始自动切输入源（不违反隐私边界——本地文件）。

## 主线四：治理与证据（贯穿始终）

- 每 Stage 走完整门禁（tsc → lint → build → 回归）+ trace/replay 证据留存；
- 新能力全部按决策文档规则**先追加决策再写代码**（决策 61-65 已示范该纪律）；
- 演示叙事对齐决策 1 卡位：「唯一本机无 bot + 会中实时理解 + 中文技术会议」；
- 简历证据边界：RTF 0.43、P95 ≤8s 等数字必须与仓库实测报告一致；MCP/vault 等未完成项在简历中如实标注进行中（决策文档规则 3 在简历语境同样适用）。

## 执行顺序总览

```
现在        → 会中询问 A 阶段（决策 67，见 2026-08-28-cuemind-live-ask-plan.md）
之后        → 会中询问 B 阶段（卡片「问更多」入口）→ 2.1b（LA-2，需麦克风实机）
再之后      → 主线三（桌面壳 + 首跑向导）
已完成      → 主线一（M1-M3）✅ / 主线二（2.1-2.3）✅ / 主线五（训练数据导出）✅
永不        → 移动端、云端 diarization、实时协同、Obsidian 插件形态、自建知识库、在线自学习、主动问题检测
```

### 主线五：离线训练数据闭环（决策 65，轻量档）

- `scripts/export-training-data.ts`：账本 + trace → SFT 指令对（窗口文本→关键词判断）+ DPO 偏好对（漏报构造）；
- 零训练成本；中档（LLaMA-Factory 微调验证）仅在简历需要时人工触发；
- 红线：纯离线、人工把关、不接实时链路、不自动改 Prompt/权重。

## 第二规划期执行纪律

1. 一次只派发一个 Stage 给子会话，交接靠计划文档 + 提示词，遇决策点回报而非自行发挥；
2. 所有旁路（账本/导出/MCP）不得侵占卡片 P95 ≤8s 红线——每期验收必查；
3. 每条新能力先更新决策文档再写代码（60+ 条决策的教训：先锁契约，防止实现漂移）。
