# CueMind 交接文档（Handoff）

> 用途：写给一个**完全没有上下文的新会话**。接手后请先读本文件，再读
> `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md`（实施计划）和
> `progress.md` / `task_plan.md`（进度与任务追踪）。

---

## 1. 项目是什么

CueMind 是一个**本地优先的实时会议认知助手**（meeting copilot）。技术栈：

- **Next.js 15**（App Router）、**React 19**、TypeScript、Tailwind v4，无数据库、无鉴权。
- 单页三栏 UI：转录 / 实时建议卡片 / 流式聊天。
- **ASR**：本地 `whisper.cpp`（`1.9.3-dev` + `ggml-small.bin` 多语种），另保留原 Groq 转录路径。
- **认知卡片**：本地 `llama.cpp`（默认）或**显式配置的远端 OpenAI-compatible API**；流程是
  关键词 → 网络搜索 → 生成带来源的中文解释卡片。
- **搜索**：Tavily / Bing / SerpAPI。

仓库根：`/home/work/asr/CueMind`（git 仓库），分支 `codex/local-realtime-meeting-copilot`。
`@/*` 路径别名指向仓库根（见 `tsconfig.json`）。

---

## 2. 关键运行事实（本机）

- **无测试套件**。验证闭环固定为：
  `npx tsc --noEmit` → `npm run lint` → `npm run build`（**build 是真正的门禁**，会对每条
  route/page 做生产级类型检查）。
- **GPU 可用**：NVIDIA GeForce RTX 4060 Ti 8 GB，WSL2 下 `/dev/dxg` 可用，`nvidia-smi` 显示
  CUDA UMD 13.3。跑 llama.cpp 用 `-ngl 99` 全层卸载。
- **llama.cpp**：`/home/work/llama.cpp/build/bin/llama-server`，`0.3.0-dev (build 1, commit 1729ed5)`，
  CUDA 构建（同目录 `libggml-cuda.so` 存在）。
- **模型**：`/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`（约 2.5 GB），
  SHA256 `2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e`。
- **whisper.cpp**：源码构建 `1.9.3-dev`，CPU/OpenMP 后端；模型
  `/home/work/asr/.runtime/models/ggml-small.bin`。
- **设置默认** `llamaCppBaseUrl = http://127.0.0.1:8082`（`hooks/useSettings.ts` 默认值）。

---

## 3. 已完成部分

### 3.1 早期（迁移之前）

P0 执行规格、P1 本地 ASR 契约、P2 fixture replay（`scripts/validate-replay.ts`）、P3 trace 与
提示注入边界、P1-runtime 真实 whisper small 模型 smoke。对应提交 `94d11c2` → `23ff8be`。

### 3.2 Llama provider 迁移（2026-08-26 计划）—— 已全部完成

| 任务 | 内容 | 提交 |
| --- | --- | --- |
| P0.1 | 冻结 llama.cpp/provider 迁移基线 | `b27307a` |
| P1.1 | provider 类型 + 5 个类型化错误码 | `36d7e0c` |
| P1.2 | OpenAI-compatible JSON 客户端（`/v1/chat/completions`） | `27e976b` |
| P1.3 | `lib/llama-cpp.ts` / `lib/remote-api.ts` 包装器 | `25db0e3` |
| P1.4 | settings 字段 + 密钥存储迁移 | `974fd71` |
| P1.5 | 设置 UI provider 选择 | `57ad3f7` |
| P1.6 | context-card 路由 provider 选择 + 失败态 | `ae2ed4f` |
| P1.7 | 移除 Ollama 运行时语义 | `981af32` |
| P1.8 | 真实本地 provider smoke | `71c32bf` |
| （修正） | 记录 GPU smoke 证据 | `a293de8` |

要点：

- 两个 provider（`llama.cpp` 本地 + `remote-api` 远端）是**两个薄包装器**，共享一个
  `generateOpenAiCompatibleJson<T>` 客户端（`lib/model-provider.ts`），**无插件注册表/策略模式**。
- 密钥用 `cuemind_*` 命名空间单独存储（localStorage/sessionStorage/内存），从
  `cuemind_settings` blob 剥离，**绝不进 trace**（`ModelProviderError` 序列化也不含 key）。
- trace 记录 `provider`/`model`/`baseUrl`，不含 API key、不含完整转写。
- P1.8 smoke 结果（单次，非稳定基准）：关键词 `"Cloud Code"`，输入 31 段/413 字符；
  GPU `-ngl 99` 关键词延迟 **510 ms**，CPU `-ngl 0` 延迟 1793 ms。

---

## 4. 当前在哪里发生阻碍

1. **P2（replay 与 provider 评估 harness）尚未开始** —— 这是 2026-08-26 计划里**最后一块未做
   的工作**。代码本身无阻塞：`tsc` / `lint` / `build` 全绿。
2. **实时搜索与远端 API 未验证**：本环境没有配置 Tavily/Bing/SerpAPI 的 API key，也没有可用的
   远端 OpenAI-compatible 端点，因此无法做真实搜索 / 远端 provider 的端到端验证。
3. **端到端卡片延迟未验证**：目前只测了关键词生成；搜索 + 卡片组装 + 端到端链路仍未测。

---

## 5. 下一步是什么

1. 读 `docs/plans/2026-08-26-cuemind-llama-provider-implementation-plan.md` 的 **P2** 章节，按
   **spec-first** 纪律执行（先看任务边界与验证命令，再动手）。
2. P2 大致范围：replay 与 provider 评估 harness —— `scripts/validate-replay.ts` **已存在**
   （来自早期 P2），还需新增 `scripts/evaluate-model-providers.ts`、`fixtures/`、`reports/`、
   `docs/evaluation/`（以计划文件为准）。
3. 评估用 **GPU（`-ngl 99`）** 跑真实 provider，不要用 mock/offline 数据冒充真实性能。

---

## 6. 不要重犯的错误

（来源：原交接约束 + 本会话新发现）

1. **不要重新引入 Ollama** 作为主抽象或隐式 fallback。运行时语义已在 P1.7 移除
   （`lib/ollama.ts` 已删除）。
2. **不要把 remote-api 当无提示自动降级**：必须由用户显式配置，且 trace 里标注 provider 身份。
3. **不要在 provider / 结构化输出 / 超时 / 错误终态验证完成前，开始 LoRA、模型合并或量化。**
4. **不要把 mock/offline 延迟当成真实生产性能**；smoke 数据要标注"单次 CPU/GPU 测量，非稳定基准"。
5. **不要覆盖或删除**：`dataset/`、`docs/deployment/`、设计文档、实施计划、`findings.md`。这些目前
   是 untracked，应保留、勿提交、勿删除。
6. **每个阶段单独提交 + 跑对应 phase gate**；git 提交由主 agent 负责。
7. **跑模型前先查 GPU**（`nvidia-smi`、`ls /dev/dxg`）。本会话一开始用 `-ngl 0` 跑 CPU 才发现
   有 RTX 4060 Ti 8 GB；应优先 `-ngl 99` 全层卸载。
8. **停止 llama-server 用 `pkill -x llama-server`**（精确进程名），**不要**用
   `pkill -f "build/bin/llama-server"` —— 后者会匹配到自己命令行里的 bash 进程并误杀 shell
   （本会话曾 exit 144）。定位进程用 `pgrep -x llama-server`。

---

## 7. 常用命令（可复现）

**启动 llama-server（GPU，全层卸载）：**

```bash
cd /home/work/llama.cpp/build/bin && ./llama-server \
  -m /home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8082 \
  --alias /home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  -ngl 99 --ctx-size 4096
```

**跑本地 provider smoke：**

```bash
cd /home/work/asr/CueMind && TMPDIR=/tmp npx tsx scripts/run-local-model-smoke.ts \
  http://127.0.0.1:8082 \
  /home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  /tmp/cuemind-runtime/cuemind-10min-asr.json \
  /tmp/cuemind-runtime/local-model-smoke.json
```

**验证门（每个阶段都要跑）：**

```bash
npx tsc --noEmit
npm run lint
npm run build
```

**已有回归脚本：**

```bash
TMPDIR=/tmp npx tsx scripts/test-model-providers.ts
TMPDIR=/tmp npx tsx scripts/test-context-card-route.ts
TMPDIR=/tmp npx tsx scripts/test-local-asr.ts
TMPDIR=/tmp npx tsx scripts/validate-replay.ts fixtures/demo-meeting/sample-events.jsonl reports/replay
```
