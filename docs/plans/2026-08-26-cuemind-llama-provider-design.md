# CueMind Llama Provider Design

> 日期：2026-08-26
> 范围：模型 provider 抽象、设置项、context-card 路由、错误边界、测试边界
> 目标：彻底移除 Ollama 语义，改为 `llama.cpp` 本地 provider + `remote api` 远端 provider

## 1. 背景

当前 CueMind 的实时认知卡片链路仍以 `Ollama` 作为本地模型语义入口，但实际部署已经转向 `llama.cpp + Qwen3-4B-Instruct-2507-Q4_K_M`。继续保留 Ollama 命名会带来三个问题：

1. 配置语义与真实运行时不一致。
2. `app/api/context-cards/route.ts` 只能映射到单一 provider，无法显式区分本地和远端。
3. 后续调试时，模型地址、模型名、API key 和失败类型都不容易审计。

因此第一版设计直接移除 Ollama 语义，改成两个显式 provider：

- `llama.cpp`：本地优先，默认用于日常开发和桌面端本机运行。
- `remote api`：OpenAI-compatible `/v1/chat/completions`，作为显式远端兜底。

## 2. 设计目标

- 本地和远端共用同一套结构化输出 schema。
- 设置项清楚表达 provider、baseUrl、model、apiKey。
- 路由层能明确记录当前是哪个 provider 在生成卡片。
- 失败时能区分：
  - 本地模型不可达
  - 远端 API 不可达
  - 模型返回非 JSON
  - JSON 虚构但 schema 不合法
- 不引入 Ollama 回退路径，不保留 Ollama 作为主命名。

## 3. 非目标

- 不在这一版做多供应商自动选择。
- 不在这一版做静默失败切换。
- 不在这一版做复杂 header 映射或任意认证模板。
- 不在这一版改变现有 search provider 体系。
- 不在这一版修改 ASR 链路。

## 4. 总体方案

### 4.1 Provider 抽象

定义统一模型调用契约：

```ts
interface ModelProvider {
  provider: "llama.cpp" | "remote-api";
  baseUrl: string;
  model: string;
  apiKey?: string;
  chatJson<T>(args: {
    system: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<T>;
}
```

实现上不直接暴露“生成文本”的松散接口，而是只暴露“返回 JSON 的 chat completion”能力。这样可以让卡片路由始终做结构化校验，不把 prompt 的成功当成结构化成功。

### 4.2 统一 API

本地 `llama.cpp` 和远端 API 都按 `OpenAI-compatible /v1/chat/completions` 处理：

- 请求体使用 `messages`。
- 模型输出通过 assistant content 解析。
- 若模型支持 `response_format`，则可显式发送 JSON object 约束；若不支持，则仍需做本地 JSON 解析和 schema 校验。

统一入口可以减少 route 分支复杂度，并让切换 provider 只影响配置，不影响上层业务逻辑。

## 5. 代码边界

### 5.1 新增

- `lib/llama-cpp.ts`
  - 封装本地 `llama-server` 请求。
  - 默认调用 `http://127.0.0.1:8082/v1/chat/completions`。
  - 默认不强制 API key。

- `lib/remote-api.ts`
  - 封装远端 OpenAI-compatible 请求。
  - 支持 baseUrl、model、apiKey。
  - 作为明确的远端兜底 provider。

### 5.2 修改

- `app/api/context-cards/route.ts`
  - 按 `settings.modelProvider` 选择 provider。
  - 移除 `generateOllamaJson` 依赖。
  - 记录 provider 名称、endpoint、模型名和失败分类。

- `hooks/useSettings.ts`
  - 删除 `ollamaBaseUrl`、`ollamaModel` 作为主语义。
  - 新增：
    - `modelProvider`
    - `llamaCppBaseUrl`
    - `llamaCppModel`
    - `llamaCppApiKey`
    - `remoteApiBaseUrl`
    - `remoteApiModel`
    - `remoteApiApiKey`

- `components/SettingsModal.tsx`
  - 按 provider 显示对应配置项。
  - 明确区分“本地 llama.cpp”和“远端 API”。

- `types/settings.ts`
  - 同步更新设置类型。

### 5.3 删除或废弃

- `lib/ollama.ts`
  - 第一版目标是废弃，不再作为主入口。
  - 如果暂时保留文件，只能用于迁移期，不应被新代码引用。

## 6. 设置模型

建议默认值：

```ts
modelProvider: "llama.cpp"
llamaCppBaseUrl: "http://127.0.0.1:8082"
llamaCppModel: "/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
llamaCppApiKey: ""
remoteApiBaseUrl: ""
remoteApiModel: ""
remoteApiApiKey: ""
```

策略：

- 本地开发默认选 `llama.cpp`。
- 远端 API 只有在用户显式填入后才可用。
- 远端字段为空时，不进行隐式 fallback。
- provider 切换只改变模型层，不改变搜索层或 ASR 层。

## 7. 路由流程

### 7.1 context-card 生成

1. 接收最近转写、已知关键词、chunk IDs、search provider 和 model settings。
2. 读取 `modelProvider`。
3. 调用对应 provider 的 `chatJson<T>()`。
4. 对返回内容做 JSON parse 和 schema 校验。
5. 若关键词判断失败，返回 `skipped`。
6. 若搜索失败，返回 `search_failed`。
7. 若卡片生成失败，返回 `model_failed`。

### 7.2 Trace 要求

trace 必须记录：

- `modelProvider`
- `modelBaseUrl`
- `modelName`
- `inputChunkIds`
- `events[]`
- `finalState`
- `totalLatencyMs`

不要把整段转写原文塞进 trace。trace 里只保留足够审计的元数据，转写内容仍按不可信输入处理。

## 8. 错误边界

要把“模型不可用”和“模型返回无效内容”分开：

- `model_unreachable`
  - 本地 `llama-server` 没起
  - 远端 baseUrl 无法连接
  - API key 不合法

- `model_invalid_json`
  - assistant content 不是 JSON

- `model_schema_invalid`
  - JSON 可解析，但字段不满足 schema

- `model_timeout`
  - 请求超时

- `search_failed`
  - 搜索工具失败，不归因于模型

这一区分是面试可讲的重点，因为它体现了把“失败原因”显式化，而不是仅仅返回一个通用错误。

## 9. 迁移策略

这次迁移不做无提示破坏，建议按下面方式处理：

1. 新增 provider 配置项。
2. 新增 `llama.cpp` 适配器。
3. 在 route 中接入新 provider。
4. 更新 UI。
5. 迁移旧设置：
   - 如果本地存量里有 `ollamaBaseUrl` / `ollamaModel`，可在首次加载时映射到 `llamaCppBaseUrl` / `llamaCppModel`。
   - 迁移后不再写回旧字段。
6. 删除 UI 和类型中的 Ollama 命名。

## 10. 测试计划

### 10.1 单元测试

- provider 请求构造是否正确。
- JSON parse 是否能识别模型响应。
- schema 校验失败是否返回可读错误。
- provider 切换是否选择正确 baseUrl。

### 10.2 路由测试

- `modelProvider=llama.cpp` 时走本地 endpoint。
- `modelProvider=remote-api` 时走远端 endpoint。
- 无效 JSON / 无效 schema / 超时 / 连接失败返回对应 failure reason。

### 10.3 端到端 smoke

- 本地 `llama.cpp` 对真实 10 分钟转写做一次关键词提取。
- 远端 API 用同一段转写做一次关键词提取。
- 记录两者 latency、failure mode 和输出稳定性。

## 11. 验收标准

文档层面通过的标准：

- 方案明确移除 Ollama 语义。
- 本地和远端 provider 都是 OpenAI-compatible。
- 配置、路由、trace、错误边界都有清晰定义。
- 测试范围能覆盖 provider 选择和结构化输出校验。

实现层面下一步应满足：

- 本地 `llama.cpp` 能直接服务 CueMind。
- 远端 API 可作为显式兜底。
- `context-cards` trace 能区分 provider。
