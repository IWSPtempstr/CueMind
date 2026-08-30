# Phase 1 anomaly matrix

Date: 2026-08-30  
Services: `cuemind-llama.service` (`-np 1`, GPU), Next `:3000`

| Scenario | Evidence | Terminal state | Fail-closed |
|---|---|---|---|
| Keyword extraction failure/timeout | `scripts/test-ask-route.ts` termHint fallback | answered with deterministic fallback | yes |
| Search failure / insufficient sources | `scripts/test-ask-route.ts`, `scripts/test-vertical-sources.ts` | degraded; no generation on insufficient sources | yes |
| Model timeout / HTTP failure | `scripts/test-model-providers.ts`, `scripts/test-ask-route.ts` | model_failed; no answer chunks | yes |
| Schema violation | `scripts/test-ask-route.ts` | invalid_schema; no answer chunks | yes |
| Service restart/recovery | `systemctl restart cuemind-llama.service`; health and app probes | health OK, app HTTP 200 | yes |
| GPU pressure observation | `nvidia-smi` after restart | RTX 4060 Ti, 6433/8188 MiB, 16% GPU | observed only; no destructive stress |

Commands and results:

- `TMPDIR=/tmp/cuemind-tsx npx tsx scripts/test-ask-route.ts` passed.
- `TMPDIR=/tmp/cuemind-tsx npx tsx scripts/test-model-providers.ts` passed.
- `TMPDIR=/tmp/cuemind-tsx npx tsx scripts/test-vertical-sources.ts` passed.
- Restart probes: `health={"status":"ok"}`, application status `200`.

Boundary: mock-based rows prove route fail-closed control flow; restart/GPU rows prove recovery and observed resource state, not an artificial out-of-memory stress test.
