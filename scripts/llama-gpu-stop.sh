#!/usr/bin/env bash
# 停止沙箱外启动的 llama-server（普通终端执行）。
set -euo pipefail
PID_FILE=/home/work/logs/cuemind/llama-server-8082.pid

if [ ! -f "$PID_FILE" ]; then
  echo "pid 文件不存在：$PID_FILE"
  exit 1
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "stopped pid $PID"
else
  echo "pid $PID 未在运行"
fi
rm -f "$PID_FILE"
