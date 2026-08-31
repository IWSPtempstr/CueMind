# 检索韧性与会后体验设计

**状态：已批准（方案 B）。**
**范围：** 先实现检索与缓存韧性测评，以及会后整理版转写、脱敏导出和时间定位数据；暂不实现 Electron 音频播放器或 `cuemind://` 跳转协议。

## 目标

1. 证明垂直检索、通用搜索回退、来源不足和超时终态可重复；
2. 区分冷缓存、卡片预热命中、询问热命中和 TTL 过期未命中；
3. 会后生成可回退的整理版转写，不改写原始转写；
4. 生成可审计的脱敏副本和时间线数据，为未来音频 seek 保持接口稳定。

## 方案

复用 `lib/search.ts`、`lib/ask-cache.ts`、`lib/transcript-polish.ts` 和现有 Vault/JSONL 报告约定。新增评测 fixture 与执行器，不把外网瞬时波动直接当作回归结论。

### 检索与缓存韧性

评测矩阵必须覆盖：

- 一个垂直源超时、其他源提供至少两个有效结果；
- 垂直源不足时回退通用搜索；
- 回退来源不足、所有源超时、非法来源字段；
- 冷缓存、卡片预热后的命中、同一询问热命中、TTL 到期；
- 大小写、空白和别名规范化后的稳定 `cacheKey`；
- 重复候选抑制与缓存统计口径。

缓存记录增加来源标记：`ask` 或 `context_card`。报告中的命中分类固定为 `cold_miss`、`card_warmed_hit`、`ask_hot_hit`、`expired_miss`，不得将上游卡片预热误报为询问热缓存。

每次运行写入 `reports/retrieval-resilience/<run-id>/`：

```text
manifest.json
cases.jsonl
failures.jsonl
scorecard.json
report.md
```

### 会后整理版转写

- `transcriptChunks` 是不可变原始事实；
- 会议结束后异步调用本地 `polishTranscript`；
- 只允许错别字、标点和段落整理，不允许增删事实、翻译或总结；
- 超时、不可用、空输出或校验失败时回退原文；
- 保存整理版本、模型/Prompt 版本、生成时间和失败原因。

### 脱敏导出

脱敏只作用于导出副本，不修改 SQLite、浏览器会话或 Vault 原件。首版使用确定性规则和用户提供词典，覆盖邮箱、电话、证件/银行卡样式编号、密钥样式字符串、人名、公司名和项目代号。替换使用稳定占位符，如 `[PERSON_1]`、`[ORG_1]`。

导出附带 `redaction-manifest.json`，只记录规则版本、替换类型和数量，不记录原始敏感值。由于中文实体识别不能保证完整，导出结果必须标记需人工复核；不以 LLM 自动脱敏作为默认路径。

### 时间定位

Markdown、JSON 和 Vault 输出继续保留 `startMs/endMs` 与 `[mm:ss]`。新增 `timeline.json`，关联：

```text
transcript chunk → card → ask → meeting report section
```

首版只提供导出内的稳定锚点，不生成未经播放器验证的音频 URL。未来桌面播放器直接消费同一时间线实现受控本地 seek。

## 验收边界

- 评测 fixture 与真实网络运行分开标记；
- 原始转写、会话和 Vault 文件不可覆盖；
- 脱敏副本不包含已匹配的原始敏感词；
- 时间线毫秒值与 `TranscriptChunk.startMs/endMs` 一致；
- 缓存命中分类与实际缓存来源一致；
- 每个子阶段独立测试、报告和本地提交。

