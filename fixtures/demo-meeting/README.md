# Demo Meeting Fixture

The reproducible demo is defined by `demo-manifest.json`. It freezes the existing
Chinese AI Agent technical-talk recording, its verified SHA256, and the
`0-600000 ms` segment. The manifest also pins the local ASR model path/hash and
the concrete candidate-window parameters used by the demo contract.

This is a local fixture, not a pure-git artifact: a fresh checkout must already
have the media file available at `mediaPath` or copy it into that exact path
before the demo can run.

Before running a demo, verify the media file exists at the manifest's
`mediaPath` and compare its SHA256 with `mediaSha256`:

```bash
sha256sum 'dataset/【十字路口】探秘 Claude Code，搞懂 Agent Harness｜对谈来新璐【视频播客】 - Orig.mp4'
```

Changing the media file, frozen time range, ASR model, or windowing rules
requires a new manifest version. Do not silently update `demo-manifest-v1`.

The manifest is a declarative contract for the replay/update tasks in the
implementation plan. It becomes executable when the later replay loader reads it;
until then, it is the frozen fixture definition.

The final demo should produce 3-5 sourced context cards and a latency breakdown
with P50/P95 values.

Store raw private recordings outside git. Commit only small synthetic JSONL fixtures.

Each replay line is a validated desktop event. Use `transcript_ready` lines for a transcript-only replay, or preserve `audio_chunk_ready` lines when testing the future local ASR boundary.
