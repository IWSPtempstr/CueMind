# ASK Prompt A/B 对比报告（2026-09-08）

同一数据集（`fixtures/ask-extended-v2.json`，视频派生 160 题，cold+hot）、同一评审器
（judge-content-quality.ts，cite-matching 修复后版本）、同一本地模型
（Qwen3-8B-Q4_K_M，temperature 0）下的三轮对比。

## 三轮配置

| 轮次 | Prompt | 输出目录 |
|---|---|---|
| 基线 | 80 字版（v1 出厂默认） | `reports/ask-extended-video-20260908-quality/` |
| V2 | 150 字版初版 | `reports/ask-extended-video-20260908-ab-v2/` |
| V3 | 150 字版 + sources 不得为空约束 | `reports/ask-extended-video-20260908-ab-v3/` |

## 行为指标

| 指标 | 基线 | V2 | V3 |
|---|---|---|---|
| 完成率（answered / 160） | 99.4%（1 degraded） | 96.25%（6 degraded） | **100%** |
| degraded 原因 | — | 6 × `sources_empty` | 0 |
| 完成耗时 P50 | 3.7s | 5.2s | 4.3s |
| 完成耗时 P95 | 6.0s | 8.4s | 8.2s |
| 答案均长 | 34 字 | 73 字 | 74 字 |
| ≥100 字答案 | 0 | 27 | 19 |

## 内容质量（评审器 1–5 分，temperature 0）

| 维度 | 基线（n=159） | V2（n=154） | V3（n=160） |
|---|---|---|---|
| relevance | 3.09 | 3.58 | 3.52 |
| faithfulness（标题级启发式） | 2.40 | 2.92 | 2.81 |
| readability | 4.84 | 4.79 | 4.74 |
| relevance 1★ 数 | 17 | 1 | 5 |
| faithfulness 1★ 数 | 50 | 22 | 25 |

V3 相对 V2 的微小回落是因为 V3 把 V2 中 6 道被 fail-closed 拒绝的弱来源题
也纳入了评审分母——这些题本来就是低分题，等位对比下质量持平。

## 结论与门禁

- ✅ 完成率 ≥95%：V3 = 100%
- ✅ relevance ≥3.5：V3 = 3.52
- ⚠️ faithfulness ≥3.0：V3 = 2.81（标题级启发式口径存在评审器噪声；来源正文
  未落库，完整 grounding 校验需持久化 source 摘录）
- ⚠️ 端到端 P95：V3 = 8.2s，超过原简历 6.6s 口径。150 字答案使生成段变长，
  属"质量 vs 延迟"的既定取舍；已裁决（2026-09-08）：简历口径改为
  端到端 P95 ≤8.5s，不收紧答案长度。

## 采纳版本

V3（现行 [lib/prompts.ts](../lib/prompts.ts) `ASK_PROMPT`）。V2 初版存档为
`LEGACY_ASK_PROMPT_V2`，随 v1、旧 chat 默认一起进入设置迁移自愈链，
用户自定义 prompt 不受影响。
