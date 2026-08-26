# Provider Evaluation

`scripts/evaluate-model-providers.ts` evaluates structured keyword output against the same fixed first 60-second window of a recorded whisper.cpp transcript. It runs each configured provider independently and never falls back from one provider to another.

## Reproduce

```bash
TMPDIR=/tmp npx tsx scripts/evaluate-model-providers.ts
```

Defaults use:

- Input: `/tmp/cuemind-runtime/cuemind-10min-asr.json`
- Local endpoint: `http://127.0.0.1:8082`
- Local model: `/home/work/models/cuemind/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`
- Repetitions: `3`
- Output: `reports/provider-evaluation/`

Override local settings with `LLAMA_CPP_BASE_URL`, `LLAMA_CPP_MODEL`, and `LLAMA_CPP_API_KEY`. The API key is used only in the request and is not written to reports.

Remote evaluation is attempted only when all of these are explicitly set:

```bash
REMOTE_API_BASE_URL=...
REMOTE_API_MODEL=...
REMOTE_API_KEY=...
```

If any value is missing, the remote result is `blocked_external_dependency`; no remote run, latency, or quality result is fabricated. Remote report URLs are reduced to the endpoint origin.

## Artifacts

The evaluator writes `manifest.json`, `outputs.jsonl`, `errors.jsonl`, `latency.jsonl`, `scorecard.json`, and `report.md`. The denominator records requested, completed, and excluded runs. `validJsonCount` means the provider response was parseable JSON; `schemaValidCount` additionally requires a non-empty `keyword` string.

The current report is evidence for one local model's structured-output validity, keyword repeat consistency, and measured request latency only. It is not evidence for live search, source grounding, card quality, ASR quality, or production readiness. The current remote status remains blocked until an explicit compatible endpoint is supplied.
