# 垂直信息源升级设计（arXiv + Hacker News 优先检索）

> 日期：2026-08-27
> 状态：已确认（路径 A）
> 背景：对标分析「Catch-Up」类产品后确认 CueMind 端到端延迟已领先（3.4s vs 5.4s），最大短板是信息源质量——通用搜索对技术术语的命中精度低于垂直源。本设计保持「认知辅助」定位不变，只升级检索层。

## 目标

卡片检索从「Tavily 通用搜索单路」升级为「**垂直源优先、通用搜索兜底**」的两级管线：

1. **一级（垂直）**：arXiv + Hacker News 并行检索，免 key、延迟可控、技术术语命中精度高；
2. **二级（通用）**：垂直源不足 2 条可用结果时，回落现有 Tavily → agent-reach 链路（行为完全不变）。

## 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 垂直源范围 | arXiv（Atom API）+ HN Algolia（`hn.algolia.com/api/v1/search`） | 与对标产品一致；均公开免费免 key；XML/JSON 直出 |
| XML 解析 | 零依赖手写 Atom entry 提取（title/summary/id 正则切片） | arXiv Atom 格式 15+ 年稳定；避免为此引入 fast-xml-parser 依赖 |
| 触发策略 | 垂直优先，够 2 条即短路，不走 Tavily | 延迟收益：垂直并行 ~1.5-2s 且省去 Tavily 1-2s；质量优先 |
| 查询构造 | 垂直源用**原始 keyword**（不加 `technology explanation` 后缀）；Tavily 保持现查询 | 后缀对学术库是噪声；现有行为零改动 |
| 超时预算 | 垂直阶段 2.5s 独立预算；超时/不足即进入二级，不重试垂直源 | 卡片链总预算不变（route 现有 4s×2 重试结构不动） |
| 来源标识 | `SearchResult` 增加 `sourceType: "arxiv" \| "hackernews" \| "web"` | 卡片 UI 显示来源徽标（论文/讨论/网页），用户可信度判断 |

## 改动文件

| 文件 | 改动 |
|---|---|
| `lib/arxiv-search.ts`（新） | `searchArxiv(keyword, timeoutMs, signal)`：调 `export.arxiv.org/api/query`（`search_query=all:"<keyword>"`、`max_results=4`、`sortBy=relevance`），解析 Atom 取 title/summary(id→url)；结果映射 `sourceType:"arxiv"` |
| `lib/hn-search.ts`（新） | `searchHackerNews(keyword, timeoutMs, signal)`：Algolia `search?query=<keyword>&tags=story&hitsPerPage=4`，取 title/url/story_text 摘要；`sourceType:"hackernews"` |
| `lib/search.ts` | ① `SearchResult` 加可选 `sourceType`；② 新导出 `searchKeywordSources(args)`：并行跑 arXiv+HN（Promise.allSettled），过 `ensureUsableResults`（去重沿用），≥2 条直接返回 `{provider:"vertical", results}`；否则 fall through `searchTavilyWithFallback` 现链路；③ 现有 `searchWeb` 签名与行为**零改动**（replay/评估路径不受影响） |
| `app/api/context-cards/route.ts` | `searchWithRetry` 改调 `searchKeywordSources`；trace 的 `provider` 联合类型扩展 `"vertical"`；`fallbackUsed` 语义 = 是否落到通用搜索 |
| `types/suggestions.ts` + 卡片来源 UI | `ContextCard.sources` 透传 `sourceType`；`LiveSuggestions`/卡片来源行显示徽标：📄论文 / 💬HN / 🌐网页 |
| `scripts/test-vertical-sources.ts`（新） | mock fetch 用例：arXiv Atom 解析、HN JSON 解析、并行合并去重、单源失败容错（allSettled）、<2 条回落 Tavily、超时回落、现有 searchWeb 回归不变 |
| `docs/evaluation/search-card-evaluation.md` | 追加垂直源证据边界说明 |

## 延迟与失败语义

- 垂直阶段预算 2.5s；两源并行，任一失败不拖累另一源（allSettled）。
- 双双失败或合并 <2 条 → 立即进入现有 Tavily→agent-reach 链路，**总失败语义与现状完全一致**（`InsufficientSearchSourcesError` 仍由 `ensureUsableResults` 抛出）。
- trace 新增记录：`verticalHit: boolean`（是否由垂直源短路），供评估报告区分来源路径。
- P50 预期：垂直命中路径 ≈1.5-2s（优于现 Tavily 路径）；端到端出卡 P50 预期 3.4s → ~2.5-3s。

## 明确不做

- 不引入 XML 解析依赖、不加新 API key 配置项；
- 不改 `searchWeb` 现有行为（replay / evaluate-context-cards 全兼容）；
- 不做来源可信度分级（那是 grilling 决策 47 的范围，另行立项）；
- 不动卡片生成提示词（后续可提示模型优先引用论文摘要，另做增量验证）。

## 验证

1. 静态门禁：`npx tsc --noEmit && npm run lint && npm run build`（停 dev server 后 build）。
2. 新回归 `test-vertical-sources.ts` 全绿；`test-context-card-route.ts`、`test-model-providers.ts` 不回退。
3. 真机冒烟：冻结素材跑卡片链路，确认 trace 出现 `provider:"vertical"` + `verticalHit:true`，卡片来源含 arXiv/HN 徽标，P50 实测记录进 progress.md。
