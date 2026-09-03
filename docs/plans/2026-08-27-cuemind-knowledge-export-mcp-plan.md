# CueMind 知识沉淀（vault 导出）+ 本地 MCP Server 实施计划

> 日期：2026-08-27（2026-08-28 修订：M1/M2 已完成并验收；M3 需求更新——飞书接入取消、转写导出三档开关）
> 状态：M1 ✅ / M2 ✅ / M3 待实施
> 依据：`docs/product/cuemind-grilling-decisions.md` 决策 61/62/63/64 与决策清理记录
> 性质：本计划是 demo-design「暂不纳入」条款要求的"另立版本化设计与验收契约"
> 已裁决（2026-08-28）：**不接入飞书等任何云端知识端点**——vault（本地 markdown 文件夹）是唯一沉淀目的地；M4（云端 sink 抽象）取消

## 背景速读（新会话必读）

1. 先按优先级读：`CLAUDE.md` → `AGENTS.md` → `README.md`（项目约定）
2. 再读决策 61/62/63/64（上述决策文档末尾）：vault 外接沉淀 + 本地只读 stdio MCP server + 不接云端端点 + 转写导出三档开关
3. 关键架构事实：
   - 服务端 SQLite 已存在（`lib/chat-store.ts`，better-sqlite3 + WAL + `CUEMIND_DATA_DIR` 环境变量 + createRequire 降级 JSONL 模式）；M1 已落地 `lib/session-store.ts` + `app/api/sessions`，M2 已落地候选账本（`candidates` 表 + MCP 三工具）
   - Milvus 已删除，禁止任何向量检索/embedding
   - vault 路径约定：导出根目录由 `CUEMIND_VAULT_DIR` 指定（未设置时默认 `CUEMIND_DATA_DIR/vault`），目录名 `cuemind/` 固定

## 总原则（三期共同硬约束）

- 全部为**旁路**设计：任何写入 fire-and-forget，不侵占实时链路延迟预算（卡片 P95≤8s 红线）
- MCP server 全程只读；不做云端、不做 OAuth、不做写工具（v1）
- 每期独立提交，过完整静态门禁（`npx tsc --noEmit && npm run lint && npm run build`，build 前停 dev server）+ 相关回归脚本
- 禁止 `git add dataset/`；禁止把 vault/MCP 能力接入本期实时触发链路（M3 读方向明确排除在实时链路外，另立子项目）
- 用户上传媒体一律 mkdtemp 临时目录，finally 清理

## M1：stdio MCP server + 服务端会话持久化

### 前置：会话落库

新文件 `lib/session-store.ts`（复刻 chat-store.ts 模式，共用 `.data/cuemind.db`）：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  duration_ms INTEGER,
  input_source TEXT,
  transcript_json TEXT NOT NULL,
  cards_json TEXT,
  metrics_json TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title, transcript_text, content='');
```

- API：`upsertSession(snapshot)` / `listSessions({from,to,limit})` / `getSession(id)` / `searchSessions(query)`
- 写入入口：新增 `app/api/sessions/route.ts`（POST upsert），前端在现有 storeSession 处 fire-and-forget 调用，失败静默不阻塞
- FTS 中文用 2-gram 切分写入 transcript_text（FTS5 默认 tokenizer 对中文无效）

### MCP server 本体

独立目录 `mcp-server/`（独立 package.json + tsconfig，不进 Next 构建图）：

```
mcp-server/
├── package.json        # @modelcontextprotocol/sdk + zod + better-sqlite3
└── src/
    ├── index.ts        # StdioServerTransport + McpServer
    ├── db.ts           # new Database(path, { readonly: true })；db 缺失返回可解释错误终态
    └── tools/
        ├── list-sessions.ts       # from?/to?/limit?
        ├── get-session.ts         # session_id + offset/limit（转写默认 50 chunks/页）
        └── search-transcripts.ts  # query/limit? → FTS5 命中 + 会话引用
```

- 环境变量沿用 `CUEMIND_DATA_DIR`（与主应用同约定，零新配置）
- 日志只走 stderr（stdout 专属 JSON-RPC）；无任何出站网络调用

### 验证

- spawn 自测脚本：list tools → 调三个工具 → 断言无写路径
- 主项目静态门禁零影响（目录隔离）；`test-context-card-route.ts`、`test-model-providers.ts` 不回退

## M2：卡片与候选账本工具

### 前置：账本落库

```sql
CREATE TABLE IF NOT EXISTS candidates (
  session_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  term TEXT NOT NULL,
  final_state TEXT NOT NULL,   -- card_shown | suppressed_as_duplicate | model_skip | search_failed | timeout | invalid_schema ...
  suppress_reason TEXT,
  card_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, candidate_id)
);
```

写入点：`app/api/context-cards/route.ts` 候选终态判定处（trace 同源位置），事务追加，fire-and-forget。

### 新增工具

- `search_cards(query)`：按 term/别名（SQL LIKE + FTS，无语义）
- `get_card(card_id)`：正文 + 来源列表（title/url/sourceType/获取时间）+ 证据时间窗 + 起源会话
- `get_session_ledger(session_id)`：全候选终态与抑制原因（决策 26/28 终态枚举）

### 验证

三新工具自测 + 卡片链路回归不回退（断言旁路写入零延迟侵占）。

## M3：vault 导出与读取合流

### 转写导出三档开关（决策 64，2026-08-28 新增）

- 偏好存储：localStorage 键 `cuemind_export_transcript`，取值 `"none" | "folded" | "full"`，默认 `"folded"`
- 交互模式：全局默认 + 导出时（会话结束导出弹层）可临时切换，一次性覆盖
- 各档行为（仅作用于 meetings/ 的转写正文，**concepts/ 卡片永不降档、始终完整导出**）：

| 档位 | meetings/ 转写内容 | 适用场景 |
|---|---|---|
| `none` | 不写转写正文，仅主题摘要 + 卡片链接列表 | vault 会同步到云端/共享（隐私最小化） |
| `folded`（默认） | 转写放入 Obsidian callout 折叠块 `> [!note]- 完整转写` | 个人 vault：默认不干扰阅读，检索仍可命中 |
| `full` | 转写平铺正文 | 需要逐句精读/复盘 |

- frontmatter 增加 `transcript: none|folded|full` 字段如实记录档位（导出档位成为笔记的自描述元数据，MCP 与后续工具可据此判断该会话有无全文）
- 折叠块用 Obsidian 原生 callout 语法（`> [!note]-`，阅读视图渲染为折叠块，移动端一致），不用 HTML `<details>`
- 不变量：trace、密钥、原始音频永不导出（红线，与档位无关）

### 写方向（主应用内）`lib/vault-exporter.ts`

- 会话结束 → 写 `cuemind/meetings/<date>-<topic>.md`（raw 契约：frontmatter 含 date/duration/input_source/asr_model/audio_hash/transcript，正文 = 主题摘要 + 卡片链接 + 按三档开关处理的转写，落盘后不可变）
- 用户点「有用」→ 写 `cuemind/concepts/<term>.md`（frontmatter：aliases/source_types/origin_meetings/updated；正文 = 解释 + 来源列表 + 追加式变更小节；**不受三档开关影响**）
- 幂等与写前检查：`.cuemind-export.json` sidecar 记 `candidateId → {fileHash, exportedAt}`；写前 hash 不一致 = 用户编辑过 → 改走追加小节路径，绝不覆盖正文
- frontmatter 解析零依赖手写（沿用项目"手写 Atom 正则、不引 XML 依赖"先例）

### 读方向（明确排除在实时链路外）

- 设计上：context-cards 路由在 `searchKeywordSources` 之前插入 vault 精确匹配层（文件名 + aliases 等值 → 短路出卡，`sourceType:"vault"`，trace 记 `provider:"vault"`）
- 但本期**不实现**——属独立子项目，需另立版本化设计（决策 61 已声明）。M3 只做 MCP 侧读取

### MCP 合流

`search_cards`/`get_card` 数据源扩展为 SQLite ∪ vault/concepts（frontmatter aliases/updated 透出）；MCP 进程对 vault 只读。

### 验证

导出幂等（同会话重放断言文件不变）、用户编辑检测（手工改文件后重导出断言走追加）、**三档开关**（各档导出产物断言：none 无转写正文且 frontmatter 如实标注 / folded 含 callout 折叠块 / full 平铺；concepts/ 在任一档位下均完整）、既有 8 回归脚本全绿。

## 提交序列

M1 ✅（session-store + mcp-server）→ M2 ✅（账本落库 + 新工具）→ M3（三笔：转写三档开关 + vault-exporter + MCP 合流）。每笔过门禁后独立提交。
