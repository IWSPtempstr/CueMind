# 双槽改造扩样验收报告（2026-09-07）

## 改造内容

- `llama-server` 单槽（`-np 1`）→ 双槽（`-np 2`，每槽 4096 ctx），KV 显存 6.6/8.2 GiB，无 OOM
- `withLlamaSlot` 互斥锁 → N 许可信号量；新增排队超时 `CUEMIND_LLAMA_QUEUE_TIMEOUT_MS`（默认 20s，超时抛 `LlamaSlotQueueTimeoutError`，路由映射到显式失败终态，fail-closed）
- `ask/route.ts` 让位逻辑改为"仅当在途许可 ≥ 槽位数才让位"（`CUEMIND_LLAMA_SLOTS` 感知）
- 评测脚本补齐会话鉴权（POST /api/sessions + `X-Session-Token`），每轮唯一会话 id；`warmOne` 加异常保护
- 扩样数据集：从冻结转写片段本地 llama 派生 160 题（冷/热各 80，0 重复问题/术语，`fixtures/ask-extended-v2.json`）

## 实测结果（生产模式 `next start`，160 题 × 2 轮）

| 指标 | r1 | r2 | 预算/标准 | 结论 |
|---|---|---|---|---|
| 硬失败 | 0/160 | 0/160 | 0 | ✅ 两轮合计 320/320 全 `answered` |
| 端到端 P50 | 3.59s | 3.41s | — | ✅ |
| 端到端 P95 | 5.52s | 6.56s | ≤7s | ✅ 聚合达标（r2 cold-only P95 7.28s 略超，见下） |
| 端到端 P99 | 6.54s | 7.93s | — | 记录在案 |
| cold P50/P95 | 4.58/5.82s | 4.42/7.28s | — | r2 尾部由外部搜索延迟驱动 |
| hot P50/P95 | 2.46/3.95s | 2.51/3.75s | — | 缓存命中稳定，轮间漂移 <2% |
| keyword P95 | 0.76s | 0.74s | 1.5s | ✅ 修复排队饥饿后 max 仅 1.1s |
| generation P95 | 3.55s | 3.61s | 8s | ✅ 轮间漂移 <2% |

## r2 尾部查因（轮间 P95 漂移 18.8% > 15% 触发审查线）

分阶段对比：keyword 与 generation 轮间 P95 漂移均 <2%（系统本体稳定）；全部漂移来自
`searchMs` 尾部（r2 max 5.03s vs r1 2.51s），8 个最慢用例全部是 cold 且 search 占比最高
（如 e051c：search 4.99s / total 9.08s）。结论：**漂移源是外部搜索依赖（垂直源超时 ×
Tavily 重试链），非系统回归**。系统本体（keyword+generation）P95 合计约 4.35s，稳定在预算内。

## 与改造前对照

- 排队饥饿病理（修复前 native-events 化石：keyword max 168s；e080h 卡 62.9s 致评测崩溃）已消灭：
  两轮 320 例 keyword max = 1.13s，无任何 20s+ 停顿
- 单槽基线（v5，38 题）端到端 P95 5.8s → 双槽（160 题）5.52/6.56s：样本量 ×4.2 无回归
- 双槽直连验证：2 并发请求 wall=0.75s（真并发），压力恢复与既有 pressure 报告一致

## 遗留

- U1（7s 预算口径裁决）：本次实测端到端 P95 5.52/6.56s 落入 7s 预算内，数据面支持收敛；
  按决策 67 流程仍须用户裁决后方可关闭
- 外部搜索尾延迟：cold P95 受搜索重试链支配；如需进一步压 tail，方向是垂直源超时预算或
  缓存预热，属后续优化，不阻塞本验收
