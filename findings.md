# Findings

- Documentation protocol committed as `f1bd011` before execution.
- Current `dataset/` contains six MP4 files; ffprobe shows all six currently have AAC audio and H.264 video streams.
- Existing upload pipeline can convert media and run local whisper.cpp, but it does not persist video-to-card lineage by itself.
- Re-import attempt used ffmpeg and `/home/work/asr/.runtime/build/bin/whisper-cli` with `ggml-small.bin`; whisper reported `no GPU found` and CPU 4-thread processing for a 2127.5s file, making full six-video transcription impractical in one blocking run.
- The first video was converted to `reports/video-reimport-20260830/audio/39256460576-1-192.wav`; transcription was interrupted before a complete transcript artifact was produced.
