# Request timeline report

- Status: complete
- Success/failed: 3/0
- Missing events: {"capture_start":3,"capture_end":3,"asr_start":3,"asr_end":3,"keyword_start":3,"keyword_end":3,"render_start":3,"render_end":3}
- Evidence: Observed SSE boundaries plus explicitly marked stage-time derivations. Ask route does not expose capture/ASR/render events, so missing fields remain null.
