# Request timeline report

- Status: complete
- Success/failed: 3/0
- Missing events: {"capture_start":3,"capture_end":3,"asr_start":3,"asr_end":3,"render_start":3,"render_end":3}
- Evidence: Native pipeline events are preferred when emitted by the route. Legacy SSE boundaries and stage durations remain marked as derived; capture/ASR/render stay null when this Ask-only runner has no browser audio/render context.
