# Demo Meeting Fixture

The final demo should use a 10-minute technical meeting recording with 8-12 AI or engineering terms. The MVP acceptance run must produce 3-5 sourced context cards and a latency breakdown with P50/P95 values.

Store raw private recordings outside git. Commit only small synthetic JSONL fixtures.

Each replay line is a validated desktop event. Use `transcript_ready` lines for a transcript-only replay, or preserve `audio_chunk_ready` lines when testing the future local ASR boundary.
