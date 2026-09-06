#!/usr/bin/env bash
# 让本地 llama-server（cuemind-llama.service）保持常热，避免空闲后首次请求
# 触发 CUDA/KV-cache 冷启动（实测可达 10s+），导致卡片链路 5s/8s 预算内超时。
#
# 背景：llama-server 一旦活动，后续请求 ~100-300ms；但空闲一段时间后首个请求
# 可能需数秒。CueMind 的 context-cards 关键词/生成预算仅 5s/8s，撞上冷启动即
# 误报 "provider timed out"。此脚本周期性发一个最小 completion 请求保活。
#
# 由 systemd `cuemind-llama-warmup.service` 拉起（Restart=always）。对 8082 不可达
# 时静默跳过（llama 重启间隙不阻塞、不报错）。
set -euo pipefail

BASE_URL="${LLAMA_WARMUP_BASE_URL:-http://127.0.0.1:8082}"
MODEL="${LLAMA_WARMUP_MODEL:-/home/work/models/cuemind/Qwen3-8B-Q4_K_M.gguf}"
INTERVAL_SECONDS="${LLAMA_WARMUP_INTERVAL:-10}"

warmup_once() {
  # 最小 completion：json_object + 极短输出，开销最小，却能保持模型驻留/热态。
  curl -s --max-time 10 -X POST "$BASE_URL/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"warmup\"}],\"max_tokens\":4,\"stream\":false,\"temperature\":0.1,\"response_format\":{\"type\":\"json_object\"}}" \
    >/dev/null 2>&1 || true
}

# 启动即预热一次，之后按间隔保活。
warmup_once
while true; do
  sleep "$INTERVAL_SECONDS"
  warmup_once
done
