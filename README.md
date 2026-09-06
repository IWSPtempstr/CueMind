<div align="center">

# CueMind

**会中予言，会后成识** — 本地优先的会议 AI 副驾

[![Next.js](https://img.shields.io/badge/Next.js-15-000000?style=flat&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=flat&logo=sqlite&logoColor=white)](https://www.sqlite.org)
[![whisper.cpp](https://img.shields.io/badge/whisper.cpp-local%20ASR-8A2BE2)](https://github.com/ggml-org/whisper.cpp)
[![llama.cpp](https://img.shields.io/badge/llama.cpp-local%20LLM-F9D371)](https://github.com/ggml-org/llama.cpp)
[![MCP](https://img.shields.io/badge/MCP-read--only-7C3AED)](https://modelcontextprotocol.io)

</div>

---

## 📖 项目简介

CueMind 是一个本地优先的会议 AI 副驾：会议进行中，录音（或上传的媒体文件）被实时转写成带时间戳的文字，并按节奏产出一批结构化的现场建议——此刻该追问什么、哪个说法需要核查、哪个新词值得展开；每条建议可以点开成**带来源的上下文卡片**（关键词检测 → arXiv / Hacker News / GitHub / Stack Overflow 垂直检索 → 通用 Web 兜底 → 逐候选溯源的中文解释卡）；会中可随时以转写为事实底座流式追问；散会后自动生成决策 / 行动项 / 跟进清单报告。

项目重点不在于简单调用模型，而是围绕几件具体的事：浏览器 MediaRecorder 分片的容器头陷阱与重叠录制、转写失败的分片级恢复、上下文窗口策略（早段摘要 vs 近段原文的取舍）、以及每一次出站检索的可溯源。这些环节都有流水事件（pipeline-events）、回放（replay）与固定评测夹具支撑，行为可复现。

**本地优先**：音频、转写、推理全部留在本机（whisper.cpp + llama.cpp）；联网检索是唯一的出站调用，且每个回答带来源可回溯；远端 OpenAI-compatible API 是显式配置的备选项，没有静默云默认。数据统一落 `CUEMIND_DATA_DIR`（SQLite WAL 主后端 + JSONL fallback）。会话与卡片可沉淀入本地知识库并导出 Markdown Vault（外部编辑冲突检测），经一个本地只读 MCP server 供任意 MCP 客户端检索。

## ✨ 核心功能

- **实时转写**：双 MediaRecorder 重叠录制（~30s 自包含分片）或上传媒体文件 → ffmpeg 转码 16k 单声道 → whisper.cpp 按 60s 窗口转写；失败分片指数退避重试、静默跳过空分片、电平表实时可见
- **现场建议**：早段摘要 + 近段窗口双层上下文，五种建议标签（question / talking_point / answer / fact_check / clarify），JSON Schema 约束输出 + 上一批建议做防重复回路；卡片可置顶、忽略、评分
- **来源式上下文卡片**：关键词检测 → 垂直来源检索（arXiv / Hacker News / GitHub / Stack Overflow）→ 通用 Web 兜底 → 带来源解释卡，逐候选 trace，来源点击可溯
- **会中追问**：SSE 流式问答，转写作为独立 system 块锚定事实，回答短促直接；支持中途停止、失败重试与追问 chips
- **会后报告**：决策 / 行动项 / 跟进清单三段式报告；转写搜索与时间戳让长会可扫读
- **会话与回放**：最近会话快照自动保存、刷新可恢复；流水事件落库，处理链路可回放排查
- **知识沉淀**：卡片一键存入本地知识库（乐观锁编辑、归档 / 恢复），`/knowledge` 页检索管理；可导出 Markdown Vault（幂等重导出，外部编辑冲突检测），并经本地只读 MCP server（stdio，14 个检索工具，无出网）暴露给 MCP 客户端
- **隐私与安全**：知识条目隐私状态机（`clear / redacted / privacy_uncertain / blocked`），blocked 条目不出本地边界、对 MCP 不可见，导出走脱敏副本而原文不动；会话令牌鉴权、请求体上限、每路由 IP 限流、CSP 等安全响应头

## 🖼️ 项目截图

| 三栏工作台：实时转写 · 上下文卡片 · 会中问答 | 本地知识库管理页 |
|---|---|
| ![三栏工作台](docs/images/main1.png) | ![知识库管理](docs/images/knowledge.png) |

## 🏗️ 技术架构

系统流程：

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Web as Next.js 工作台
    participant ASR as whisper.cpp
    participant LLM as llama.cpp
    participant Src as 垂直来源检索
    participant Store as SQLite / JSONL
    participant Vault as Markdown Vault
    participant MCP as MCP 客户端
    User->>Web: 上传录音 / 点击开麦
    loop 每个分片（重叠录制 ~30s）
        Web->>ASR: WebM/Opus 自包含分片
        ASR-->>Web: 文本分片（领域词汇偏置）
        alt 分片转写失败
            Web->>Web: 指数退避入重试队列
        end
    end
    loop 每 ~30s 建议刷新
        Web->>LLM: 早段摘要 + 近段窗口 + 防重复上下文
        LLM-->>Web: 结构化建议批次（Schema 约束）
    end
    Web->>Src: 关键词检索（arXiv / HN / GitHub / SO / Web）
    Src-->>Web: 来源片段（逐候选 trace）
    Web->>LLM: Context Card 生成（带来源）
    User->>Web: 提问 / 点击建议卡
    Web->>LLM: 转写为事实底座的流式回答（SSE）
    Web->>Store: 会话 / 卡片 / 询问 / 流水落库
    User->>Web: 停止会议 → 会后报告；卡片存入知识库
    Web->>Vault: 知识条目导出（隐私门控 / 冲突检测 / 脱敏副本）
    MCP->>Store: 只读检索（14 个 stdio 工具，无出网）
```

存储契约：会话快照、候选卡片、询问记录、知识条目与流水事件统一落 `CUEMIND_DATA_DIR`；SQLite（better-sqlite3 + WAL）为主后端，JSONL 为显式 fallback（`CUEMIND_SESSION_STORE` / `CUEMIND_KNOWLEDGE_STORE`），两套后端共享同一接口与语义。检索是确定性关键词检索（bigram 分词），不依赖向量库与 Embedding。

## 🛠️ 技术栈

| 类别 | 技术 |
|---|---|
| 应用框架 | Next.js 15（App Router，Route Handlers 即 API 层）、React 19 |
| UI | Tailwind CSS 4、三栏工作台（转写 / 建议 / 对话） |
| 本地推理 | whisper.cpp（`whisper-cli` 子进程，ASR）、llama.cpp / `llama-server`（LLM，OpenAI-compatible） |
| 数据存储 | better-sqlite3（WAL）+ JSONL fallback：会话、候选、询问、知识、流水事件 |
| 检索 | 关键词 bigram 检索、arXiv / Hacker News / GitHub / Stack Overflow 垂直来源 + 通用 Web |
| 隐私与安全 | 隐私状态机 + 脱敏副本导出、会话令牌鉴权、每路由限流、CSP 响应头 |
| MCP | `@modelcontextprotocol/sdk`（本地 stdio 只读 server） |
| 部署 | Docker（模型目录只读挂载）、Vercel |
| 语言 | TypeScript 5 |

## 🚀 快速开始

### 1. 准备环境

- Node 18.18+
- [llama.cpp](https://github.com/ggml-org/llama.cpp)（`llama-server`，OpenAI-compatible）
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)（`whisper-cli`）+ 一个 GGML 模型
- FFmpeg（在 PATH 中，或用 `CUEMIND_FFMPEG_PATH` 指定）

### 2. 启动本地模型服务

```bash
# LLM：推荐 Qwen3-4B 档小模型做低延迟结构化输出（详细调参见 docs/deployment/qwen3-4b-llama-cpp.md）
llama-server -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf --port 8082 -c 4096 --flash-attn
```

Whisper 通过 `CUEMIND_WHISPER_PATH` / `CUEMIND_WHISPER_MODEL_PATH` 指定可执行文件与模型，由应用按分片调用，无需常驻服务。

### 3. 配置环境变量

```bash
export CUEMIND_DATA_DIR="$PWD/.data"                    # 数据目录（SQLite/JSONL、流水事件）
export CUEMIND_WHISPER_PATH=/path/to/whisper-cli        # whisper.cpp 可执行文件
export CUEMIND_WHISPER_MODEL_PATH=/path/to/ggml-model.bin
export CUEMIND_VAULT_DIR="$PWD/vault"                   # 可选：知识 vault 导出根目录
export LLAMA_CPP_BASE_URL=http://127.0.0.1:8082/v1      # 可选：默认即此值
export LLAMA_CPP_MODEL=qwen3-4b-instruct
```

| 变量 | 用途 |
| --- | --- |
| `CUEMIND_DATA_DIR` | 数据目录：会话 / 卡片 / 询问 / 知识 / 流水事件，默认 `./.data` |
| `CUEMIND_WHISPER_PATH` / `CUEMIND_WHISPER_MODEL_PATH` | whisper.cpp 可执行文件与模型路径 |
| `CUEMIND_FFMPEG_PATH` | ffmpeg 路径（默认取 PATH 中的 `ffmpeg`） |
| `CUEMIND_VAD_MODEL_PATH` | 可选：VAD 模型，用于静默检测 |
| `CUEMIND_VAULT_DIR` | 知识 vault 导出根目录（Markdown + 冲突检测元数据） |
| `CUEMIND_SESSION_STORE` / `CUEMIND_KNOWLEDGE_STORE` | 存储后端：默认 sqlite；设为 `jsonl` 走 JSONL fallback |
| `LLAMA_CPP_BASE_URL` / `LLAMA_CPP_MODEL` | 本地 llama-server 根地址与模型 |

推理设置（模型地址、上下文窗口、提示词）也可在应用 Settings 里运行时调整，路由优先取请求值、回退默认值。远端 OpenAI-compatible API 是显式配置的备选 Provider，不配置就只走本地。

### 4. 启动应用

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`：上传会议录音（Upload）或点击麦克风开讲；转写与建议每 ~30s 自动刷新；点开建议卡即得带来源解释卡并可流式追问；停止会议生成会后报告；卡片一键存入知识库，访问 `/knowledge` 检索、编辑与导出。

生产构建注意：`npm run build` 前必须停掉 `:3000` dev server——turbopack dev 与 next build 共写 `.next` 目录会导致产物损坏。

### 5. Docker（可选）

```bash
docker compose up -d   # :3000，模型目录挂载 ./models 只读 /models
```

### 6. 只读 MCP server（可选）

```bash
cd mcp-server && npm install && npm run build
node dist/index.js     # stdio JSON-RPC，stdout 仅协议、日志走 stderr、无出网
```

提供 14 个只读工具（会话 / 卡片 / 转写 / vault / 知识列表、详情、检索、版本、来源），可接入任意 MCP 客户端做本地知识检索；隐私 blocked 条目对 MCP 不可见。

## 📁 项目结构

```text
CueMind/
├── app/                    # Next.js App Router：页面 + API 路由
│   ├── api/                # sessions / suggestions / context-cards / ask /
│   │                       # knowledge / vault-export / pipeline-events …
│   └── knowledge/          # /knowledge 知识库管理页（三栏）
├── components/             # 三栏工作台 UI 组件
├── hooks/                  # 客户端 hooks（录音 / 上传 / 建议 / 卡片）
├── lib/                    # 业务核心：存储（SQLite+JSONL）、检索、隐私状态机、
│                           # vault 同步、会话鉴权、redaction、telemetry
├── mcp-server/             # 本地只读 stdio MCP server（14 个检索工具）
├── docs/                   # 设计文档、部署指南与实施计划
├── scripts/                # 回归测试脚本（tsx 直跑路由 handler）
├── fixtures/               # 固定评测夹具（检索可复现）
├── reports/                # 评测与性能报告产物
└── docker-compose.yml
```
