# CueMind 会中询问（Live Ask）实施计划 —— A 阶段

> 日期：2026-08-28
> 状态：待实施（A 阶段可立即开工）
> 依据：`docs/product/cuemind-grilling-decisions.md` 决策 67（含决策 56 变更记录）
> 性质：本计划是会后追问 → 会中询问改造的版本化设计与验收契约
> 参照系：微软 Teams Facilitator（2026-09 GA）同范式；CueMind 差异 = 全本地生成、无 bot、外发仅关键词

## 背景速读（新会话必读）

1. 先按优先级读：`CLAUDE.md` → `AGENTS.md` → `README.md`，再读决策 67 与决策 56 变更记录
2. 主线一（vault/MCP）、主线二（实时体验）、主线五（训练数据导出）均已完成验收，不要改动其行为
3. 可复用资产（勿重造）：
   - `lib/search.ts` + `lib/vertical-sources` 相关逻辑（卡片链路搜索，垂直源短路 + 通用回退 + ≤2 次尝试）
   - `lib/llama-cpp.ts`（本地 provider 解析与 JSON 生成）
   - `lib/chat-store.ts` + `/api/chat-messages`（持久化与同步，语义升级为询问历史）
   - 卡片来源渲染样式（`ContextCard` 组件的来源块）
4. 既有会话追问实现位于：`app/api/chat/route.ts`、`hooks/useChat.ts`、`components/ChatPanel.tsx` / `ChatPanelDrawer.tsx`——**改造而非删除**

## 产品定义

- 会议进行中的单问单答：用户输入问题 → 联网搜索 → 本地生成**带 ≥2 可追溯来源**的引用式回答
- 手动触发、单飞（一次一个问题）；**主动问题检测明确不做**（决策 67 红线）
- 降级语义（对齐决策 4）：来源 <2 → 不编造，返回「没找到可靠来源」+ 已尝试说明；模型结构违规 → `invalid_schema` 终态

## 数据流

```
用户问题 + 可选术语 hint（卡片「问更多」带入）+ 最近转写窗口上下文（只读）
  → [1] 关键词提取（本地 llama，单次，≤1.5s）
  → [2] 搜索：垂直源短路 → 通用回退（≤2 次尝试；命中短 TTL 缓存直接复用）
  → [3] 引用式生成（本地 llama，JSON schema：{answer, sources[], confidence}）
  → schema 校验 + fail-closed → SSE 流式返回 → AskPanel 渲染
  → 落库（chat_messages：user 问题 + assistant 引用式答案）
```

## 文件改动清单

| 文件 | 改动 |
|---|---|
| `app/api/chat/route.ts` → 改名 `app/api/ask/route.ts` | 插入关键词提取 + 搜索步骤；提示词改引用式契约；SSE 输出增加阶段事件（`searching` / `answer_chunk` / `done` / `degraded`） |
| `hooks/useChat.ts` → 改名 `hooks/useAsk.ts` | 单飞锁（在途问题禁再发）；进度状态机；可选 `termHint` 参数 |
| `components/ChatPanel.tsx` → `AskPanel.tsx` | 来源链接渲染（与卡片来源同构）；降级态展示；阶段进度指示 |
| `lib/ask-cache.ts`（新，纯函数 + 内存缓存） | `term → results` 短 TTL 缓存（会话级，约 10 分钟），避免与卡片链路重复搜索 |
| `types/settings.ts` + `useSettings.ts` + `SettingsModal.tsx` | `chatPrompt` → `askPrompt`（默认值改为引用式生成契约；读取时兼容旧键一次性迁移，沿用既有迁移模式）；**新增「实时健康指标」折叠区**（决策 68：HealthPanel 内容迁入，打开时实时刷新） |
| `lib/chat-store.ts` | 不改动（表结构现成）；注释更新语义为询问历史 |
| `app/page.tsx` | **三栏重构（决策 68）**：中栏拆出独立 `ContextCardsPanel`（仅卡片+失败态）；右栏 `HealthPanel` 槽位换为 `AskPanel`；`ChatPanelDrawer` 移除；建议点击通路改为标注预填 |
| `components/LiveSuggestions.tsx` | 拆分：卡片渲染迁出；建议卡 UI 移除（建议改左栏内联标注，见下） |
| `components/MicTranscript.tsx` | 建议内联标注渲染（anchor 命中 chunk 行内类别徽标；点击预填右栏询问框） |
| `lib/prompts.ts` | `SUGGESTIONS_PROMPT` 输出契约增加 `anchor` 字段（近期转写子串 ≤12 字） |

## 红线（逐条硬约束）

1. **隐私最小化**：搜索请求外发仅问题 + 提取关键词；绝不外发整段会议文本（决策 33 延伸）
2. **实时链路零侵入**：询问只读 `transcriptChunks`，不注入不修改；转写/卡片/账本行为零变化
3. **询问让位**：与卡片链路并发时询问排队（串行队列），卡片 P95 ≤8s 不动摇——验收必查
4. **不编造**：来源 <2 走降级文案；schema 违规走 `invalid_schema` 终态（对齐决策 4 fail-closed）
5. **不做主动检测**：仅手动触发；不监听转写自动发起询问

## UI 重构（决策 68，与 A 阶段同批交付）

三栏语义重排：

| 栏 | 改造前 | 改造后 |
|---|---|---|
| 左 | 转写 | 转写 + **建议内联标注**（anchor 命中 chunk 行内徽标；点击预填右栏询问框） |
| 中 | 建议卡 + 卡片混合 | **仅上下文卡片**（独立 `ContextCardsPanel`）+ 失败/降级态 |
| 右 | HealthPanel | **AskPanel**（询问输入/阶段进度/引用式回答） |
| 设置窗口 | — | 新增「实时健康指标」折叠区（HealthPanel 内容迁入，打开时实时刷新） |

- 建议输出契约：`SUGGESTIONS_PROMPT` 增加 `anchor`（近期转写子串 ≤12 字）；**无锚点命中的建议丢弃**；命中 = 大小写不敏感子串匹配首个 chunk
- 移除：`ChatPanelDrawer`、旧建议卡 UI（置顶/忽略/复制按钮随卡移除）
- 建议生成节奏与模型调用不变；卡片链路零改动；健康指标数据源不变（仅渲染位置迁移）

## 延迟预算

| 阶段 | 预算 |
|---|---|
| 关键词提取 | ≤1.5s |
| 搜索（含缓存判断） | ≤2.5s |
| 答案生成（流式） | 首字节 ≤3s，完成 ≤3s |
| **总** | **首字节 ≤3s，完成 P95 ≤7s** |

询问延迟**独立统计**（新 telemetry stage：`ask_keyword` / `ask_search` / `ask_generation`），不混入卡片 P95 指标。

## 验收

- 新脚本 `scripts/test-ask-route.ts`：
  - 来源 ≥2 → 引用式答案 + sources 结构断言
  - 来源不足 → 降级文案终态（不编造）
  - schema 违规 → `invalid_schema` 终态
  - 缓存命中 → 第二次同关键词不发真实搜索（mock 计数断言）
  - 外发内容断言：请求体不含会议转写文本（隐私红线可测化）
- 新脚本 `scripts/test-suggestion-anchor.ts`：anchor 命中/未命中（未命中丢弃）、大小写不敏感、≤12 字截断、类别徽标映射
- 既有回归全绿；**`test-context-card-route.ts` 在模拟询问并发下重跑，P95 断言不回退**
- `askPrompt` 旧键迁移用例
- UI 冒烟：三栏渲染（中栏无建议卡、右栏为询问）；点击转写标注预填询问框；设置折叠区健康字段与旧面板一致
- 门禁：每笔提交过 `tsc --noEmit && npm run lint && npm run build`（build 前停 :3000 dev server）

## 提交序列

```
1. feat: rename chat prompt contract to askPrompt with citation schema (settings + migration)
2. feat: ask route with keyword extraction, web search and fail-closed generation
3. feat: ask cache for term-level search reuse
4. refactor: three-column restructure — cards-only middle, AskPanel right, health into settings (decision 68)
5. feat: inline suggestion annotations in transcript with anchor contract
6. test: ask route + anchor regression (sources/degraded/schema/cache/privacy/anchor)
```

## B 阶段（后续，不在本计划范围）

- 卡片「问更多」入口：术语自动带入 ask box（`termHint` 参数已在本计划预留）
- 会议总结纳入询问历史（一行拼接，不新建存储）
- MCP `list_asks(session_id)` 只读工具（远期）

## 交接纪律

- 一次只做 A 阶段；遇到本计划未覆盖的决策点先停下来问，不要自行发挥
- 完成后报告：提交哈希、门禁与回归真实输出摘要、遗留问题清单
