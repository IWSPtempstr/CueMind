# CueMind.Audio

Windows-only audio helper for CueMind Desktop.

## Responsibilities

- Capture default playback device with WASAPI Loopback.
- Capture default microphone.
- Emit JSONL status and chunk events to stdout.
- Write chunk audio files to a local temp directory.

## Development Commands

```bash
dotnet restore native/CueMind.Audio/CueMind.Audio.csproj
dotnet build native/CueMind.Audio/CueMind.Audio.csproj
dotnet run --project native/CueMind.Audio/CueMind.Audio.csproj -- ./tmp/audio
```

On non-Windows hosts the helper should emit `windows_required` and exit cleanly.
