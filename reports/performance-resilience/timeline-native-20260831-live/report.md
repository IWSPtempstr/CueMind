# Request timeline report

- Status: partial
- Success/failed: 0/3
- Missing events: {"first_event":3,"first_token":3,"capture_start":3,"capture_end":3,"asr_start":3,"asr_end":3,"keyword_start":3,"keyword_end":3,"search_start":3,"search_end":3,"generation_start":3,"generation_end":3,"render_start":3,"render_end":3}
- Evidence: Native pipeline events are preferred when emitted by the route. Legacy SSE boundaries and stage durations remain marked as derived; capture/ASR/render stay null when this Ask-only runner has no browser audio/render context.
