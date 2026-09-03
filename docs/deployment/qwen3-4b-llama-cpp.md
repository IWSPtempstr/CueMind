# Qwen3-4B-Instruct-2507 + llama.cpp 部署指南

## 1. 部署目标

本指南用于在本机通过 `llama.cpp` 部署：

```text
模型：Qwen3-4B-Instruct-2507-Q4_K_M
推理框架：llama.cpp / llama-server
GPU：NVIDIA RTX 4060 Ti 8GB
系统：WSL2 Ubuntu
CUDA：/usr/local/cuda-12.3
服务地址：http://127.0.0.1:8080
用途：CueMind 本地关键词抽取和 ContextCard 生成
```

推荐初始配置：

```text
量化：Q4_K_M
上下文：4096
并发：1
GPU offload：全部可 offload 层
Flash Attention：开启
reasoning/thinking：关闭
输出长度：128-192 tokens
```

Qwen3-4B-Instruct-2507 是 4B 指令模型，适合低延迟结构化输出。CueMind 不需要使用其超长上下文能力，应先从 4096 上下文开始。

## 2. 本机检查

执行：

```bash
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free --format=csv,noheader
free -h
```

预期环境：

```text
GPU：RTX 4060 Ti，显存约 8GB
WSL 内存：约 10GB
Swap：约 4GB
CUDA：/usr/local/cuda
```

设置 CUDA 环境：

```bash
export CUDA_HOME=/usr/local/cuda
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"

nvcc --version
nvidia-smi
```

如果希望每次新终端自动生效，将以下内容加入 `~/.bashrc`：

```bash
export CUDA_HOME=/usr/local/cuda
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
```

## 3. 安装编译依赖

```bash
sudo apt-get update

sudo apt-get install -y \
  build-essential \
  cmake \
  git \
  curl \
  jq \
  python3 \
  python3-venv
```

模型和源码建议放在 WSL Linux 文件系统中，不要放在 `/mnt/c`，避免编译、模型加载和推理时产生额外 I/O 开销。

## 4. 编译 llama.cpp

```bash
mkdir -p /home/work
cd /home/work

git clone --depth 1 https://github.com/ggml-org/llama.cpp.git
cd /home/work/llama.cpp
```

针对 RTX 4060 Ti 的 Ada 架构编译：

```bash
cmake -S . -B build \
  -DGGML_CUDA=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES=89
```

编译 server、CLI 和 benchmark：

```bash
cmake --build build \
  --config Release \
  -j"$(nproc)" \
  --target llama-server llama-cli llama-bench
```

检查产物：

```bash
find /home/work/llama.cpp/build \
  -type f \
  \( -name "llama-server" -o -name "llama-cli" -o -name "llama-bench" \) \
  -print
```

通常路径为：

```text
/home/work/llama.cpp/build/bin/llama-server
/home/work/llama.cpp/build/bin/llama-cli
/home/work/llama.cpp/build/bin/llama-bench
```

记录版本：

```bash
cd /home/work/llama.cpp
git rev-parse HEAD | tee build/llama.cpp.commit
./build/bin/llama-server --version
```

确认 CUDA backend：

```bash
./build/bin/llama-server --help | grep -i cuda
```

## 5. 下载 GGUF 模型

本指南使用已经转换好的 GGUF 文件。下载前应记录：

```text
GGUF 仓库
GGUF 文件名
llama.cpp commit
SHA256
```

创建 Hugging Face 下载环境：

```bash
python3 -m venv /home/work/.venvs/hf
/home/work/.venvs/hf/bin/python -m pip install -U pip
/home/work/.venvs/hf/bin/pip install -U "huggingface_hub[cli]"
```

创建模型目录：

```bash
mkdir -p /home/work/models/cuemind
```

下载 `Q4_K_M`：

```bash
/home/work/.venvs/hf/bin/hf download \
  bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF \
  --include '*Q4_K_M.gguf' \
  --local-dir /home/work/models/cuemind
```

确认模型：

```bash
find /home/work/models/cuemind \
  -type f \
  -name '*Q4_K_M.gguf' \
  -printf '%p %s bytes\n'
```

建立固定路径：

```bash
export MODEL_PATH="$(find /home/work/models/cuemind \
  -type f \
  -name '*Q4_K_M.gguf' \
  -print -quit)"

test -n "$MODEL_PATH"
echo "$MODEL_PATH"

ln -sfn "$MODEL_PATH" \
  /home/work/models/cuemind/cuemind-qwen3-4b-instruct-2507-q4_k_m.gguf

export MODEL_PATH=/home/work/models/cuemind/cuemind-qwen3-4b-instruct-2507-q4_k_m.gguf
```

保存模型校验和：

```bash
sha256sum "$MODEL_PATH" \
  | tee /home/work/models/cuemind/model.sha256
```

> 注意：GGUF 文件可能来自社区转换仓库，不一定是 Qwen 原始仓库中的官方产物。项目报告中必须保留 GGUF 仓库、文件名、SHA256 和 llama.cpp commit。

## 6. CLI 烟雾测试

先不要启动 HTTP 服务，直接验证模型能否加载：

```bash
export LLAMA_CLI=/home/work/llama.cpp/build/bin/llama-cli

"$LLAMA_CLI" \
  -m "$MODEL_PATH" \
  -ngl all \
  -c 4096 \
  -fa on \
  -n 128 \
  -p '你是 CueMind 的本地会议助手。请用中文解释 RAG，并只输出一句话。'
```

如果出现 CUDA out of memory，按以下顺序降级：

```bash
# 1. 降低上下文
-c 2048

# 2. 降低 batch
-b 128 -ub 64

# 3. 让 Flash Attention 自动选择
-fa auto

# 4. 减少 GPU offload 层数
-ngl 30
```

## 7. 启动 llama-server

创建日志目录：

```bash
mkdir -p /home/work/logs/cuemind
export LLAMA_SERVER=/home/work/llama.cpp/build/bin/llama-server
```

### 7.1 前台启动

```bash
"$LLAMA_SERVER" \
  -m "$MODEL_PATH" \
  --alias cuemind-qwen3-4b \
  --host 127.0.0.1 \
  --port 8080 \
  --api-key cuemind-local \
  --jinja \
  --reasoning off \
  -ngl all \
  -c 4096 \
  -b 256 \
  -ub 128 \
  -np 1 \
  -fa on \
  --metrics \
  --no-webui \
  2>&1 | tee /home/work/logs/cuemind/llama-server.log
```

### 7.2 后台启动

```bash
nohup "$LLAMA_SERVER" \
  -m "$MODEL_PATH" \
  --alias cuemind-qwen3-4b \
  --host 127.0.0.1 \
  --port 8080 \
  --api-key cuemind-local \
  --jinja \
  --reasoning off \
  -ngl all \
  -c 4096 \
  -b 256 \
  -ub 128 \
  -np 1 \
  -fa on \
  --metrics \
  --no-webui \
  > /home/work/logs/cuemind/llama-server.log 2>&1 &

echo $! > /home/work/logs/cuemind/llama-server.pid
```

检查进程：

```bash
ps -fp "$(cat /home/work/logs/cuemind/llama-server.pid)"
```

停止服务：

```bash
kill "$(cat /home/work/logs/cuemind/llama-server.pid)"
```

## 8. 服务健康检查

```bash
curl -fsS \
  -H "Authorization: Bearer cuemind-local" \
  http://127.0.0.1:8080/health
```

查看模型：

```bash
curl -fsS \
  -H "Authorization: Bearer cuemind-local" \
  http://127.0.0.1:8080/v1/models | jq
```

查看服务属性：

```bash
curl -fsS \
  -H "Authorization: Bearer cuemind-local" \
  http://127.0.0.1:8080/props | jq
```

查看 Prometheus 指标：

```bash
curl -fsS \
  -H "Authorization: Bearer cuemind-local" \
  http://127.0.0.1:8080/metrics
```

## 9. CueMind 结构化 JSON 测试

创建测试请求：

```bash
cat > /tmp/cuemind-qwen3-test.json <<'JSON'
{
  "model": "cuemind-qwen3-4b",
  "messages": [
    {
      "role": "system",
      "content": "你是实时会议认知助手。只输出 JSON，不要输出 Markdown，不要输出解释。"
    },
    {
      "role": "user",
      "content": "会议片段：今天我们比较 RAG 和 fine-tuning 在企业知识库中的取舍。\n关键词：RAG\n请生成一张简短中文解释卡。"
    }
  ],
  "temperature": 0.1,
  "top_p": 0.9,
  "max_tokens": 128,
  "stream": false,
  "reasoning_effort": "none",
  "response_format": {
    "type": "json_schema",
    "schema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string"
        },
        "explanation": {
          "type": "string"
        },
        "whyNow": {
          "type": "string"
        }
      },
      "required": [
        "keyword",
        "explanation",
        "whyNow"
      ],
      "additionalProperties": false
    }
  }
}
JSON
```

发送请求：

```bash
curl -fsS \
  http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer cuemind-local" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/cuemind-qwen3-test.json \
  | tee /tmp/cuemind-qwen3-response.json \
  | jq
```

提取模型正文：

```bash
jq -r '.choices[0].message.content' \
  /tmp/cuemind-qwen3-response.json
```

检查是否为合法 JSON：

```bash
jq -e '.choices[0].message.content' /tmp/cuemind-qwen3-response.json \
  | jq -e fromjson
```

如果当前 llama.cpp 版本不接受 `json_schema`，先改成：

```json
"response_format": {
  "type": "json_object"
}
```

同时保留 system prompt 和应用侧 JSON/schema 校验。应用侧校验不能省略。

## 10. 显存与性能测试

另开一个 WSL 终端：

```bash
watch -n 1 nvidia-smi
```

重点观察：

```text
显存是否接近 8GB
是否出现 CUDA out of memory
GPU 利用率
模型是否完全 offload
显存是否持续增长
```

运行 `llama-bench`：

```bash
mkdir -p /home/work/reports/cuemind

/home/work/llama.cpp/build/bin/llama-bench \
  -m "$MODEL_PATH" \
  -ngl all \
  -fa on \
  -p 512 \
  -n 128 \
  -b 256 \
  -ub 128 \
  -r 5 \
  -o json \
  > /home/work/reports/cuemind/qwen3-4b-q4_k_m-bench.json
```

HTTP 端到端延迟：

```bash
for i in 1 2 3 4 5; do
  curl -sS \
    -o /tmp/cuemind-response-"$i".json \
    -w "request=$i total=%{time_total}s\n" \
    http://127.0.0.1:8080/v1/chat/completions \
    -H "Authorization: Bearer cuemind-local" \
    -H "Content-Type: application/json" \
    --data-binary @/tmp/cuemind-qwen3-test.json
done
```

`llama-bench` 适合测 prompt processing 和 token generation，但不完全等价于 CueMind 的 HTTP 端到端延迟。最终报告应同时记录：

```text
keyword_ms
search_ms
generation_ms
total_ms
tokens_per_second
GPU peak memory
JSON valid
card schema valid
```

## 11. 接入 CueMind

当前 CueMind 的 [lib/ollama.ts](../../lib/ollama.ts) 调用：

```text
POST /api/generate
```

并读取：

```json
{
  "response": "..."
}
```

而 llama.cpp 使用：

```text
POST /v1/chat/completions
```

返回：

```json
{
  "choices": [
    {
      "message": {
        "content": "..."
      }
    }
  ]
}
```

因此，部署完成后 CueMind 不会自动切换到 llama.cpp。需要新增 llama.cpp 适配器，或为当前 Ollama 适配器增加 provider 分支。

推荐结构：

```text
lib/ollama.ts       -> 保留 Ollama /api/generate
lib/llama-cpp.ts    -> 新增 llama.cpp /v1/chat/completions
settings.provider   -> "ollama" | "llama.cpp"
```

llama.cpp 适配器的核心请求：

```ts
const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer cuemind-local",
  },
  body: JSON.stringify({
    model: "cuemind-qwen3-4b",
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 160,
    stream: false,
    reasoning_effort: "none",
    response_format: {
      type: "json_object",
    },
  }),
  signal: controller.signal,
});

const payload = await response.json();
const content = payload.choices?.[0]?.message?.content;

if (typeof content !== "string") {
  throw new Error("llama.cpp returned invalid assistant content");
}

return JSON.parse(content) as T;
```

应用侧仍然必须校验：

- `keyword` 是否为非空字符串；
- `explanation` 是否为非空字符串；
- `whyNow` 是否为非空字符串；
- `sources` 是否恰好两个；
- URL 是否合法；
- 解释是否超过长度限制；
- 事实是否被来源支持。

不要直接把 llama.cpp 地址填入当前 `ollamaBaseUrl`，因为 API 路径和返回格式不兼容。

## 12. Windows/Electron 访问 WSL 服务

如果 CueMind Next 服务和 llama.cpp 都运行在 WSL：

```text
http://127.0.0.1:8080
```

如果 CueMind Electron 运行在 Windows，而 llama.cpp 运行在 WSL，先在 Windows PowerShell 测试：

```powershell
curl.exe http://127.0.0.1:8080/health
```

只有 Windows 无法访问时，才考虑：

```bash
--host 0.0.0.0
```

如果绑定到 `0.0.0.0`，必须同时使用 API key 和防火墙限制。不要把未认证模型服务暴露到局域网。

## 13. 常见故障

### 13.1 CUDA 找不到

```bash
export CUDA_HOME=/usr/local/cuda
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"

nvidia-smi
nvcc --version
```

### 13.2 CMake 找不到 CUDA

```bash
cmake -S . -B build \
  -DGGML_CUDA=ON \
  -DCUDAToolkit_ROOT=/usr/local/cuda \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DCMAKE_BUILD_TYPE=Release
```

### 13.3 显存不足

依次尝试：

```bash
-c 2048
-b 128 -ub 64
-fa auto
-ngl 30
```

### 13.4 JSON 不稳定

确认：

```text
--jinja
--reasoning off
temperature <= 0.2
max_tokens <= 192
response_format 使用 json_schema 或 json_object
应用侧保留 schema 校验
```

system prompt 建议包含：

```text
只输出一个 JSON 对象。
不要输出 Markdown。
不要使用代码块。
不要解释过程。
```

### 13.5 CueMind 请求超时

分别记录关键词和卡片生成超时：

```text
关键词抽取：5000ms
卡片生成：8000ms
```

如果 Qwen3-4B 在本机 P95 超过 15 秒，优先降低：

```text
context 4096 -> 2048
max_tokens 160 -> 96
batch 256 -> 128
```

## 14. 最终基线命令

完成安装和测试后，正式基线使用（2026-08-28 修订：上下文 4096 → 8192，为会中询问预留上下文；真机全卸载）：

```bash
/home/work/llama.cpp/build/bin/llama-server \
  -m /home/work/models/cuemind/cuemind-qwen3-4b-instruct-2507-q4_k_m.gguf \
  --alias cuemind-qwen3-4b \
  --host 127.0.0.1 \
  --port 8080 \
  --api-key cuemind-local \
  --jinja \
  --reasoning off \
  -ngl 99 \
  -c 8192 \
  -b 256 \
  -ub 128 \
  -np 1 \
  -fa on \
  --metrics \
  --no-webui
```

> 应用连接契约：CueMind 默认 `llamaCppBaseUrl=http://127.0.0.1:8082` 且不带 api-key。若使用上述 8080 + api-key 基线，须在设置中同步修改 baseUrl 与密钥；无 CUDA 的环境（如沙箱）会自动忽略 `-ngl` 回退 CPU，参数无需改动。

验收顺序：

```text
1. llama.cpp CUDA 编译成功
2. GGUF SHA256 已保存
3. CLI 模型加载成功
4. /health 通过
5. /v1/models 通过
6. /v1/chat/completions 返回合法 JSON
7. nvidia-smi 显存稳定
8. 5 次 HTTP 延迟测试完成
9. CueMind llama.cpp adapter 接入
10. 10 条真实会议片段 smoke 完成
```

## 15. 证据记录模板

建议保存：

```text
/home/work/llama.cpp/build/llama.cpp.commit
/home/work/models/cuemind/model.sha256
/home/work/logs/cuemind/llama-server.log
/home/work/reports/cuemind/qwen3-4b-q4_k_m-bench.json
```

评估报告还应记录：

```text
model_id
model_sha256
llama_cpp_commit
prompt_version
context_length
temperature
max_tokens
hardware
driver_version
protocol_score
keyword_score
card_content_score
source_score
total_latency_p50
total_latency_p95
unsupported_claim_rate
```

## 16. Qwen3-8B 升级路径（可选，真机专属）

RTX 4060 Ti 8GB 真机的质量升级档：Qwen3-8B Q4_K_M 全卸载约 5-6GB VRAM（含 8192 KV），速度 60-90 tok/s，中文解释与 JSON 纪律优于 4B。**无 CUDA 环境不启用**（CPU 上 8B 打爆延迟预算）。

### 16.1 下载

```bash
mkdir -p /home/work/models/cuemind

# 官方仓库优先；HF 直连失败用镜像
/home/work/.venvs/hf/bin/hf download Qwen/Qwen3-8B-GGUF \
  --include 'qwen3-8b-q4_k_m.gguf' \
  --local-dir /home/work/models/cuemind
# 镜像回退：
# curl -L -o /home/work/models/cuemind/qwen3-8b-q4_k_m.gguf \
#   https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/qwen3-8b-q4_k_m.gguf

sha256sum /home/work/models/cuemind/qwen3-8b-q4_k_m.gguf \
  | tee /home/work/models/cuemind/qwen3-8b-q4_k_m.sha256
```

### 16.2 启动（替换 4B 实例，端口与契约不变）

```bash
/home/work/llama.cpp/build/bin/llama-server \
  -m /home/work/models/cuemind/qwen3-8b-q4_k_m.gguf \
  --host 127.0.0.1 --port 8082 \
  -c 8192 -ngl 99 -fa on --jinja --reasoning off
```

`--reasoning off` 必须：Qwen3 默认 thinking 模式会先输出思维链，打爆卡片 P95 与询问首字节预算。

### 16.3 切换与回退

- 切换：改 `cuemind-llama.service` 的 `-m` 路径 → `systemctl daemon-reload && systemctl restart cuemind-llama`（应用零改动，仍连 `127.0.0.1:8082`）
- 回退：换回 4B 路径重启，配置层天然支持
- 验收门槛（决策 57/65 口径）：冻结评估集对比 4B 基线——触发 F1、schema 合法率、卡片 P95、询问首字节；任一回退即不切换
- 显存核查：`nvidia-smi` 确认占用 ≤7.5GB 且无 swap-to-RAM（`-ngl 99` 下若 OOM 降 `-c 4096`）

### 16.4 A/B 验证计划（2026-08-29 锁定）

```text
基线：Qwen3-4B（现 systemd 实例）
挑战者 1：Qwen3-8B Q4_K_M   → 下载约 5GB
挑战者 2：GLM-4-9B Q4_K_M   → 仅当挑战者 1 schema 违规率不达标时再拉
指标：触发 F1 / schema 合法率 / 卡片 P95 / 询问首字节 / 显存峰值
门槛：任一指标回退即不切换；显存 >7.5GB 降 -c 4096 复测
切换方式：改 cuemind-llama.service 的 -m 路径 → daemon-reload + restart（应用零改动）
```

执行顺序：先跑挑战者 1 的冻结集对比并记录五项指标；达标即切换并更新基线记录；不达标再拉挑战者 2 复测。结果写入 `/home/work/reports/cuemind/` 评估报告（含 model_sha256 与 llama.cpp commit，沿用第 15 节模板）。

### 16.5 基线切换记录（2026-08-29 锁定）

- **8B 达标，已切换为当前基线。** 官方 `Qwen/Qwen3-8B-GGUF` 为 gated 仓库（无 HF token），改用 `unsloth/Qwen3-8B-GGUF`（`Qwen3-8B-Q4_K_M.gguf`）。
- model_sha256：`120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4`；llama.cpp commit：`1729ed5`。
- 五项指标（4B → 8B）：触发 F1 0.667 → 0.667；schema 合法率 1.0 → 1.0；卡片 P95 3628 → 3080ms；询问首字节 P95 926 → 599ms；显存峰值 4359 → 6422 MiB（≤7.5GB，无 OOM）。
- 当前 `cuemind-llama.service` 的 `-m` 指向 `Qwen3-8B-Q4_K_M.gguf`；回退只需换回 4B 路径重启。
