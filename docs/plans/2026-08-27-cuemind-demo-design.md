# CueMind 最小演示版设计

> 日期：2026-08-27
> 状态：已获用户确认
> 来源：`docs/product/cuemind-grilling-decisions.md`

## 目标

完成一个可现场复现的 CueMind 最小演示：使用固定的约 10 分钟中文 AI Agent 技术视频，经过本地 ASR、候选窗口切分、关键词判断、联网搜索、中文解释卡生成和 trace 记录，稳定展示约 3-5 张有来源卡片。

首期证明的是“实时理解辅助链路可以稳定运行并且可解释”，不是完整的个人知识管理产品，也不是在线训练系统。

## 用户路径

```text
固定视频回放
  -> 本地 ASR 转写
  -> 8-12 秒候选窗口 + 约 2 秒重叠上下文
  -> 硬规则过滤与重复抑制
  -> 本地 llama.cpp 关键词判断
  -> 受控搜索，最多两次尝试
  -> 本地 llama.cpp 生成中文卡片
  -> 三栏界面展示转写、卡片和实时健康指标
  -> JSONL trace / replay 报告
```

模型 provider 仍使用当前已实现的 `llama.cpp`，远端 OpenAI-compatible API 只作为显式配置的演示替代，不做静默 provider 切换。

## 核心行为

### 候选窗口

- 以 ASR 已确认的句段或稳定片段作为输入。
- 通常聚合到 8-12 秒，遇到停顿、句末、说话人转换或语义完整边界时可提前闭合。
- 最长不超过 12 秒；上下文可保留约 2 秒重叠区。
- 候选 ID 绑定数据集版本、媒体 ID、核心区间、ASR 版本和切分版本。
- 重叠区只提供上下文，不单独触发候选。

### 触发策略

- 默认宁少勿错，目标是整段演示约 3-5 张卡片。
- 规范术语、确认别名和主题标签由输入契约提供；本期不做语义知识库命中。
- 泛化词、空文本、重复术语、搜索证据不足和模型低置信结果默认跳过。
- 同一规范术语每场会议默认只展示一次；本期不实现重大变化更新卡，只记录重复抑制终态。
- 硬规则优先于模型判断；冲突、超时、结构无效默认 `fail-closed`。

### 卡片

成功卡片至少包含：

```ts
interface DemoContextCard {
  id: string;
  candidateId: string;
  keyword: string;
  explanation: string;
  whyNow: string;
  sources: [
    { title: string; url: string; snippet: string },
    { title: string; url: string; snippet: string },
  ];
  generatedBy: "llama.cpp" | "remote-api";
  verified: boolean;
  transcriptChunkIds: string[];
  latencyMs: {
    asr?: number;
    keyword: number;
    search: number;
    generation: number;
    render?: number;
    total: number;
  };
}
```

实时界面只突出当前卡片和简短状态；完整来源、失败原因、请求轨迹和候选终态进入会后 replay 报告。

### 失败与降级

- 本地知识库不参与本期实时命中。
- 搜索超时、来源不足、远程服务不可用或模型结构无效时，不生成无来源事实。
- 界面显示轻量的可恢复状态，例如“搜索超时”“来源不足”“模型暂不可用”。
- 所有候选仍保留账本记录，最终状态至少区分 `card_shown`、`model_skip`、`suppressed_as_duplicate`、`search_failed`、`model_failed`、`timeout` 和 `invalid_schema`。

## 界面结构

沿用现有三栏控制台：

- 左栏：持续更新的转写、时间戳和输入来源。
- 中栏：当前上下文卡片、已生成卡片列表、失败或降级状态。
- 右栏：ASR 状态、最近窗口延迟、卡片数、队列数、成功/降级状态。

实时栏不展示完整 trace、模型 JSON、搜索响应、离线 Precision/Recall 或 Judge 分数。

## 暂不纳入

以下内容明确不属于本期实现范围，不能作为本期任务的隐含要求，也不能在演示中宣称已经完成：

1. **个人知识库与 IndexedDB 持久化**：不实现统一存储接口、IndexedDB schema、事务、索引、导入导出或 SQLite 迁移适配器。
2. **知识状态生命周期**：不实现 `provisional`、`active`、`expired`、`rejected`、`source_conflict`、`import_pending` 等跨会议知识状态。
3. **反馈学习闭环**：不实现“有用/无关/已了解”对后续会议的长期抑制、上下文负反馈、建议级负反馈或撤销恢复。
4. **会后知识审核工作台**：不实现待处理队列、批量低风险确认、高风险逐项确认、来源冲突处理和版本回滚 UI。
5. **来源版本与后台刷新**：不实现本地旧卡异步验证、低风险自动更新、高风险待确认更新、来源差异版本链和网页新鲜度服务。
6. **LLM Judge 与人工审计**：不把自动 Judge 或 20% 人工抽查作为本期发布门槛；本期只做结构、来源、终态、延迟和演示稳定性证据。
7. **在线自学习或模型训练**：不修改模型权重、不自动改 Prompt、不动态扩展主题枚举、不自动生成线上规则。
8. **完整隐私授权产品**：不实现全局/会议级远程授权 UI、细粒度数据类型授权和授权审计；本期只保留已有最小上下文与 provider 标识边界。
9. **高级来源治理**：不实现来源可信等级管理、来源策略审核、来源冲突裁决和来源注入检测的完整产品化流程；现有基础的 untrusted-data 隔离继续保留。
10. **生产级 Windows 交付**：不把 Windows helper 编译、双轨 WASAPI 实机验收、NSIS 安装包、自动更新和生产 SLA 作为 WSL 计划的完成条件；这些作为单独的 Windows 验收阶段。
11. **语义检索和 Milvus 实时接入**：不把 Milvus、embedding 或语义相似度用于本期线上触发；已有评估脚本保留，但不扩展为演示主链路依赖。

这些能力可以在本期之后另立子项目；任何未来实现都必须新增版本化设计和验收契约，不能通过本期的临时字段偷偷接入。

## 验收原则

- 固定输入、固定窗口规则和固定版本可重复运行。
- 10 分钟演示目标为 3-5 张卡片，不以大量卡片证明成功。
- 成功卡片需要两个可追溯来源；来源不足时明确失败或降级。
- 每个候选有稳定 ID、单一最终状态和完整 trace。
- 统计 P50/P95 卡片延迟，但不把它包装成生产 SLA。
- 任何 WSL、mock 或固定 snapshot 结果都必须标明证据边界。
