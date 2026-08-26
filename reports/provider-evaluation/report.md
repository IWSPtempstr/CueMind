# CueMind Model Provider Evaluation

- Status: `complete`
- Dataset: `fixed_asr_window` (0,62600)
- Input segments/chars: 31/413
- Requested runs per provider: 3
- llama.cpp version: version: 0.3.0-dev (build 1, commit 1729ed5) built with GNU 11.4.0 for Linux x86_64
- Hardware: NVIDIA GeForce RTX 4060 Ti, 8188 MiB

## Provider Results

### llama.cpp
- Status: `complete`
- Model/base URL: `/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf` / `http://127.0.0.1:8082`
- Denominator: requested=3, completed=3, excluded=0
- Valid JSON: 3/3
- Schema valid: 3/3
- Keyword repeat consistency: 1
- Latency: P50=98 ms, P95=98 ms
- Errors: {}

### remote-api
- Status: `complete`
- Model/base URL: `qwen3.8-max` / `https://dashscope.aliyuncs.com`
- Denominator: requested=3, completed=3, excluded=0
- Valid JSON: 3/3
- Schema valid: 3/3
- Keyword repeat consistency: 1
- Latency: P50=10697 ms, P95=10697 ms
- Errors: {}

## Evidence Boundary

Repeated provider structured-output and latency evidence for one fixed transcript window only; no search or card-quality claim.
Remote evaluation was executed against an explicitly configured OpenAI-compatible endpoint; endpoint reporting is reduced to the origin and no API key is written to artifacts.
Replay integrity and provider structured-output evaluation do not establish live search quality, source grounding, card correctness, or production readiness.
