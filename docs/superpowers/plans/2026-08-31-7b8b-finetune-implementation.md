# 7B/8B Finetune Implementation Plan

**Goal:** 在服务器上可重复执行 7B/8B QLoRA SFT、DPO、评估、冻结集对比、影子运行和 adapter 合并。

**Architecture:** Python 训练入口统一读取 JSONL，强制 `train`/`eval`/`freeze` 边界并为每次运行写 manifest。SFT 使用 Transformers + PEFT + bitsandbytes，DPO 使用 TRL；评估、冻结集和影子运行独立脚本，任何发布动作均需人工决策文件。

**Tech Stack:** Python 3.10+, PyTorch CUDA, Transformers, PEFT, TRL, Datasets, BitsAndBytes。

### Task 1: Training environment and data gates

- Create `training/requirements.txt`, `training/validate_data.py`, `training/common.py`.
- Validate JSONL schema, human confirmation, allowed splits, non-empty train/eval, and reject freeze input.
- Commit code only; reports and checkpoints remain ignored/local.

### Task 2: SFT/DPO runners

- Create `training/train_sft.py` and `training/train_dpo.py`.
- Use 4-bit NF4, bf16 when supported, gradient checkpointing, batch size 1, accumulation, explicit max length.
- Save adapter, tokenizer, metrics, hardware metadata, model hash, dataset hash, git commit, prompt/schema versions.

### Task 3: Evaluation and release evidence

- Create `training/evaluate.py`, `training/freeze_compare.py`, `training/shadow_run.py`, `training/merge_adapter.py`.
- Eval reads only `eval`; freeze compare requires explicit final gate and runs once; shadow records quality/schema/latency/cache/resource/failure fields.
- Merge exports a standalone Transformers model or GGUF conversion input; never overwrites source artifacts.
