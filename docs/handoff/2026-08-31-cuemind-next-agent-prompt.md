你现在接手仓库 `/home/work/asr/CueMind`。请先阅读：

1. `CLAUDE.md`
2. `README.md`
3. `docs/product/cuemind-grilling-decisions.md`
4. `docs/plans/2026-08-31-security-session-hardening.md`
5. `docs/handoff/2026-08-31-cuemind-security-handoff.md`

当前基线提交是：

```text
55a4e8a chore: checkpoint current workspace
```

目标：继续完成安全加固阶段的验证和测试修复，保持最小改动。不要回滚或删除现有用户/生成文件，不要修改与当前任务无关的 dataset、reports、`.pi` 文件。

## 当前已知状态

核心安全实现已经存在：

- `lib/session-auth.ts`
- `lib/session-route.ts`
- `lib/session-store.ts`
- `lib/server-paths.ts`
- `app/api/sessions/route.ts`
- `app/api/context-cards/route.ts`
- `app/api/ask/route.ts`
- `hooks/useContextCards.ts`

会话隔离是 session-level access token，不是用户认证。请求使用 `X-Session-Token`。服务端路径由环境配置控制，不能由 HTTP 请求覆盖。

已通过：

```bash
npx tsc --noEmit
npm run lint
git diff --check
npx tsx scripts/test-session-auth.ts
npx tsx scripts/test-session-store.ts
npx tsx scripts/test-session-route.ts
npx tsx scripts/test-ask-card-concurrency.ts
npx tsx scripts/test-summarize-route.ts
npx tsx scripts/test-media-upload-route.ts
npx tsx scripts/test-local-transcribe-contract.ts
```

## 首要任务

修复并通过：

```bash
npx tsx scripts/test-context-card-route.ts
```

最近失败位置：

```text
AssertionError: 400 !== 200
at testRemoteProviderSelected (.../scripts/test-context-card-route.ts:327:12)
```

已知测试夹具情况：

- `scripts/test-context-card-route.ts` 的 `makeRequest()` 会依据 body 的 `sessionId` 添加 `X-Session-Token`。
- bootstrap 已覆盖 `m2-route-card-shown`、`m2-route-dup`、`m2-live-simple`、`m2-bypass-probe`。
- `testRemoteProviderSelected()` 使用 `baseBody()`，目前很可能没有带 `sessionId`，所以收到 400。
- 不能通过放宽生产路由来让测试通过。
- 先检查所有 context-card 用例，决定统一给需要授权的用例增加临时 session，或者给 `baseBody()` 设置一个已 bootstrap 的默认 session。
- live-simple 无 session 的用例要根据当前生产契约处理；如果生产路由要求 session，应更新测试契约和调用方式，不要添加绕过。
- bypass probe 需要保留其特殊设计：先在有效临时数据目录创建授权 session，再把 `CUEMIND_DATA_DIR` 切回普通文件路径，验证账本写失败不影响主流程。

## 执行要求

1. 先运行 `git status --short`，确认当前工作区状态。
2. 阅读相关 route、session store 和失败测试代码。
3. 只修改必要的测试夹具或真正发现的生产缺陷。
4. 运行 context-card 回归测试。
5. 运行：

```bash
npx tsc --noEmit
npm run lint
git diff --check
```

6. 如修改属于独立安全/测试阶段，创建独立 Git 提交，提交信息使用清晰的 Conventional Commit 格式。
7. 提交前检查 `git diff --stat` 和 `git status --short`，不要误提交新的大体积数据或无关生成物。
8. 最终报告必须列出：修改文件、通过的命令、仍失败的命令、提交 hash。

## 后续任务（完成首要任务后再做）

- 为 chat、pipeline events、local memory、context cards、vault export、session title、postmeeting、local transcribe、upload、ask 补齐跨 session token rejection 测试。
- 补齐高成本接口的请求体、字段、数组、并发和单 session 大小限制。
- 抽取并测试 `useContextCards` pending queue 纯逻辑。
- 停止 `:3000` dev server 后运行 `npm run build`。
- 验证 better-sqlite3 SQLite 初始化及 JSONL fallback。
- 处理知识库 demo 契约与长期产品决策之间的漂移，但先不要越过安全修复。
- 不要在没有新版本化设计文档的情况下实现 demo 设计中的“暂不纳入”能力。

MCP 状态补充：项目级 `.mcp.json` 已正确绑定当前仓库的 `code-review-graph`，独立 MCP 握手和 `tools/list` 已成功；旧 Pi 进程可能仍显示 `MCP: 0/0 servers, 0 tools`，需 `/reload` 或重启 Pi。不要把 CLI 或独立 server 成功误报成当前 Pi 已加载。
