#!/usr/bin/env bash
# 在【普通终端（非 Trae 沙箱终端）】执行：沙箱命名空间未绑定 /dev/nvidia*，
# GPU 推理服务必须在沙箱外启动。应用侧零改动（仍连 127.0.0.1:8082）。
set -euo pipefail

LLAMA_SERVER="${LLAMA_SERVER:-/home/work/llama.cpp/build/bin/llama-server}"
MODEL_PATH="${1:-/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf}"
LOG_DIR=/home/work/logs/cuemind
PID_FILE="$LOG_DIR/llama-server-8082.pid"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "llama-server 已在运行 (pid $(cat "$PID_FILE"))，先执行 scripts/llama-gpu-stop.sh"
  exit 1
fi

nohup "$LLAMA_SERVER" \
  -m "$MODEL_PATH" \
  --host 127.0.0.1 --port 8082 \
  -c 8192 -ngl 99 -fa on --jinja --reasoning off \
  > "$LOG_DIR/llama-server-8082.log" 2>&1 &

echo $! > "$PID_FILE"
echo "started pid $(cat "$PID_FILE")，日志：$LOG_DIR/llama-server-8082.log"
echo "验证 GPU：grep -c 'ggml_cuda_init: failed' $LOG_DIR/llama-server-8082.log  # 应为 0"
