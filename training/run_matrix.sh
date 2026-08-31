#!/usr/bin/env bash
set -euo pipefail
: "${MODEL:?set MODEL to a Hugging Face 7B/8B model directory}"
: "${DATA_DIR:?set DATA_DIR to confirmed-error-analysis directory}"
: "${RUN_ROOT:?set RUN_ROOT to a new versioned output directory}"
mkdir -p "$RUN_ROOT"
for spec in "trigger-sft.jsonl:1e-4" "trigger-sft.jsonl:2e-4" "keyword-sft.jsonl:1e-4" "explanation-sft.jsonl:1e-4"; do
  file=${spec%%:*}; lr=${spec##*:}; name="${file%.jsonl}-lr-${lr}"
  python train_sft.py --model "$MODEL" --data "$DATA_DIR/$file" --out "$RUN_ROOT/$name" --lr "$lr" --epochs 3 --max-length 512 --grad-accum 8
  python evaluate.py --data "$DATA_DIR/$file" --adapter "$RUN_ROOT/$name" --out "$RUN_ROOT/$name/eval.json"
done
python train_dpo.py --model "$MODEL" --data "$DATA_DIR/explanation-dpo.jsonl" --out "$RUN_ROOT/explanation-dpo" --epochs 1 --lr 5e-5
python evaluate.py --data "$DATA_DIR/explanation-dpo.jsonl" --adapter "$RUN_ROOT/explanation-dpo" --out "$RUN_ROOT/explanation-dpo/eval.json"
