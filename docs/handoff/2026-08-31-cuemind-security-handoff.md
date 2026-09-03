# CueMind 交接文档

更新时间：2026-08-31
基线提交：`55a4e8a chore: checkpoint current workspace`
项目目录：`/home/work/asr/CueMind`

## 1. 当前结论

CueMind 已完成一轮本地部署安全加固，核心目标是“会话级隔离”，不是用户认证或多用户授权。

已完成的主要收口：

- 持久化 session 使用服务端生成的随机访问 token。
- 服务端只保存 `sessionAccessTokenHash`，HTTP 请求通过 `X-Session-Token` 认证。
- session-scoped API 统一经过 `requireSessionAccess`。
- `/api/sessions` 的读取、列表、搜索和更新按当前 session token 限定。
- whisper、模型、ffmpeg 和 vault 路径不再由 HTTP 客户端控制。
- 上传文件使用服务端临时目录，并在结束后清理。
- 实时转写、聊天、context-card、ask、pipeline event 等接口已增加请求限制和会话边界。
- `useContextCards` 已采用 pending queue，避免请求进行期间到达的 chunk 被永久丢失。
- 项目级 `.mcp.json` 已注册 `code-review-graph`，绑定当前仓库路径。

## 2. 重要提交

从旧到新：

- `624be08 security: keep transcription clients server-configured`
- `2fd42eb security: bound realtime transcription requests`
- `ca03a2a security: bound chat and card payloads`
- `95082de security: isolate expensive transcript routes`
- `c6209f9 test: cover expensive route boundaries`
- `8ade6ed test: enforce session route isolation`
- `c69d921 security: harden session access and server paths`
- `f399c68 feat: add knowledge entry API`
- `55a4e8a chore: checkpoint current workspace`

最后一个提交包含当时整个工作区的现有改动，包括文档、数据集、评测报告、删除的旧报告、`.pi` 运行产物和 `.mcp.json`。不要将这些文件误判为本轮安全代码变更，也不要擅自删除或回滚。

## 3. 关键实现位置

- Session token：`lib/session-auth.ts`
- Session 存储：`lib/session-store.ts`
- Session 类型：`types/session.ts`
- 路由授权入口：`lib/session-route.ts`
- API 限流和请求上限：`lib/api-security.ts`
- 服务端路径配置：`lib/server-paths.ts`
- Session API：`app/api/sessions/route.ts`
- Context card API：`app/api/context-cards/route.ts`
- Ask API：`app/api/ask/route.ts`
- 实时队列：`hooks/useContextCards.ts`
- 客户端 token：`lib/client-session-auth.ts`、`app/page.tsx`
- 项目 MCP 配置：`.mcp.json`
- 安全实施计划：`docs/plans/2026-08-31-security-session-hardening.md`

## 4. 已验证命令

以下检查已经通过：

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

`test-ask-card-concurrency.ts` 结果：6 个 ask 并发下，卡片 P95 没有回退，最近一次 ratio 约为 `0.902`。

## 5. 当前已知失败

### `scripts/test-context-card-route.ts`

当前脚本已补充 session bootstrap，但完整执行仍在 `testRemoteProviderSelected` 处失败：

```text
AssertionError: 400 !== 200
at testRemoteProviderSelected (.../scripts/test-context-card-route.ts:327:12)
```

根因很可能是该用例调用 `baseBody()` 时没有覆盖 `sessionId`，因此请求不带 session ID/token；普通 session bootstrap 只覆盖了：

- `m2-route-card-shown`
- `m2-route-dup`
- `m2-live-simple`
- `m2-bypass-probe`

下一位代理应先检查所有 `context-card` 用例的 `sessionId` 使用情况。建议方案是：

1. 为需要授权的用例统一设置默认 `sessionId`，例如 `m2-context-suite`。
2. `makeRequest()` 根据 session ID 自动添加 `X-Session-Token`。
3. 对无 session 的 live-simple 用例保留原本的产品行为；如果当前路由已经要求 session，则同步更新该测试契约，而不是放宽生产授权。
4. 重新运行完整 `npx tsx scripts/test-context-card-route.ts`。

## 6. 下一阶段优先级

### P0：修复和补齐回归测试

- 修复 `test-context-card-route.ts` 的 remote provider 夹具。
- 检查 bypass probe：它故意把 `CUEMIND_DATA_DIR` 指向普通文件，授权 session 必须在临时有效目录创建后再切回探针目录。
- 补齐上传、桌面转写、实时转写、pipeline event、chat、memory、vault、title、postmeeting 和 ask 的 session ID/token 专门测试。
- 检查所有测试脚本是否使用临时 `CUEMIND_DATA_DIR`，避免固定 session ID 与开发数据冲突。

### P1：统一输入边界

重点检查高成本接口：

- 请求体总大小。
- 字段长度。
- 数组长度。
- 并发数。
- 单 session 总数据大小。
- SSE/JSONL pipeline event 的最大数量和最大单条长度。

沿用 `lib/api-security.ts` 和 `lib/prompts.ts` 的既有常量，不引入新的验证框架。

### P1：运行时验证

- 停止 `:3000` dev server 后运行 `npm run build`。
- 检查 `better-sqlite3` 的 native SQLite 初始化。
- 验证 SQLite 失败时 JSONL fallback 可用。
- 确认动态 native module warning 是否只是构建提示，还是实际运行时故障。

### P2：产品契约和知识库

当前 demo 设计文档明确：本地知识库不参与本期实时命中；长期产品决策仍包含知识库状态、命中和反馈闭环。需要二选一：

- 实现完整知识库生命周期；或
- 修正文档，明确当前 demo 的实际契约。

不要在没有更新版本化设计文档的情况下实现被 `docs/plans/2026-08-27-cuemind-demo-design.md` 的“暂不纳入”列表排除的能力。

### P2：隐私闭环

尚未完整实现：

- 敏感信息检测。
- `privacy_uncertain` 状态。
- 远程授权撤销。
- 远程发送的最终状态记录。

## 7. MCP / code-review-graph 状态

项目级 `.mcp.json` 当前绑定：

```json
{
  "mcpServers": {
    "code-review-graph": {
      "command": "/root/anaconda3/envs/agent-learning/bin/code-review-graph",
      "args": ["mcp", "--repo", "/home/work/asr/CueMind"],
      "cwd": "/home/work/asr/CueMind",
      "startup_timeout_sec": 120
    }
  }
}
```

已确认：

- CLI 版本：`2.3.7`。
- 图索引更新成功：约 `1141` nodes、`10394` edges、`150` files。
- `initialize` 握手成功。
- `tools/list` 成功返回 `30` 个工具。
- `requireSessionAccess` 可被搜索，`callers_of` 找到 `17` 个调用方。

当前 Pi 进程仍显示 `MCP: 0/0 servers, 0 tools`，因为该进程尚未重新加载配置。下一次在 Pi 中执行 `/reload`；如果仍是 `0/0`，重启 Pi 会话。不要把 MCP server 独立握手成功误报成当前 Pi 已加载。

## 8. 工作规则

- 先读 `CLAUDE.md`、`README.md`、产品决策和相关 dated plan。
- 不回滚现有用户或生成文件。
- 不把 token 放入 URL、日志或导出文件。
- 不允许 HTTP 客户端覆盖服务端可执行文件、模型路径、ffmpeg 路径或 vault 根路径。
- 底层库继续兼容可信本地调用方的显式配置；只在 HTTP route 边界收紧。
- side-channel persistence 必须 fire-and-forget，不得拖慢实时卡片链路。
- 每个独立安全阶段完成并通过验证后再单独提交。
- 修改前先补最小回归测试；复杂逻辑留下一个可运行检查。
