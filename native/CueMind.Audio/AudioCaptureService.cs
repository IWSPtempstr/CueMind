namespace CueMind.Audio;

using NAudio.CoreAudioApi;
using NAudio.Wave;

public sealed class AudioCaptureService : IDisposable
{
    private const int ChunkDurationMs = 5000;
    private const int MinChunkBytes = 4096;
    private const double SilenceRmsThreshold = 0.01;

    private readonly string outputDir;
    private readonly JsonlEventWriter writer;
    private readonly TaskCompletionSource completion = new();
    private readonly List<TrackCapture> tracks = [];

    public AudioCaptureService(string outputDir, JsonlEventWriter writer)
    {
        this.outputDir = outputDir;
        this.writer = writer;
    }

    public Task Completion => completion.Task;

    public Task StartAsync()
    {
        if (!OperatingSystem.IsWindows())
        {
            writer.Write(new
            {
                type = "runtime_error",
                code = "windows_required",
                message = "CueMind audio helper requires Windows WASAPI.",
                occurredAt = DateTimeOffset.UtcNow
            });
            completion.TrySetResult();
            return Task.CompletedTask;
        }

        var enumerator = new MMDeviceEnumerator();
        var renderDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        var captureDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);

        tracks.Add(new TrackCapture(
            source: "system",
            capture: new WasapiLoopbackCapture(renderDevice),
            outputRoot: Path.Combine(outputDir, "system"),
            writer: writer));
        tracks.Add(new TrackCapture(
            source: "microphone",
            capture: new WasapiCapture(captureDevice),
            outputRoot: Path.Combine(outputDir, "microphone"),
            writer: writer));

        foreach (var track in tracks)
        {
            track.Start();
        }

        writer.Write(new
        {
            type = "runtime_status",
            status = "capture_ready",
            occurredAt = DateTimeOffset.UtcNow,
            outputDir
        });
        return Task.CompletedTask;
    }

    public void Stop()
    {
        foreach (var track in tracks)
        {
            track.Dispose();
        }
        tracks.Clear();
        completion.TrySetResult();
    }

    public void Dispose()
    {
        Stop();
    }

    private sealed class TrackCapture : IDisposable
    {
        private readonly string source;
        private readonly IWaveIn capture;
        private readonly string outputRoot;
        private readonly JsonlEventWriter writer;
        private readonly object gate = new();
        private readonly Timer rotateTimer;

        private WaveFileWriter? fileWriter;
        private string? currentPath;
        private string? currentId;
        private DateTimeOffset chunkStartedAt;
        private long totalBytes;
        private double peakRms;
        private long timelineStartMs;

        public TrackCapture(string source, IWaveIn capture, string outputRoot, JsonlEventWriter writer)
        {
            this.source = source;
            this.capture = capture;
            this.outputRoot = outputRoot;
            this.writer = writer;
            rotateTimer = new Timer(_ => Rotate(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            capture.DataAvailable += OnDataAvailable;
            capture.RecordingStopped += OnRecordingStopped;
        }

        public void Start()
        {
            Directory.CreateDirectory(outputRoot);
            lock (gate)
            {
                OpenChunk();
            }
            capture.StartRecording();
            rotateTimer.Change(ChunkDurationMs, ChunkDurationMs);
            writer.Write(new
            {
                type = "runtime_status",
                status = "track_started",
                source,
                occurredAt = DateTimeOffset.UtcNow,
                sampleRate = capture.WaveFormat.SampleRate,
                channels = capture.WaveFormat.Channels
            });
        }

        public void Dispose()
        {
            rotateTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            capture.StopRecording();
            lock (gate)
            {
                CloseChunk(emitEvent: true);
            }
            rotateTimer.Dispose();
            capture.Dispose();
        }

        private void Rotate()
        {
            lock (gate)
            {
                CloseChunk(emitEvent: true);
                OpenChunk();
            }
        }

        private void OpenChunk()
        {
            currentId = Guid.NewGuid().ToString("N");
            currentPath = Path.Combine(outputRoot, $"{currentId}.wav");
            chunkStartedAt = DateTimeOffset.UtcNow;
            totalBytes = 0;
            peakRms = 0;
            fileWriter = new WaveFileWriter(currentPath, capture.WaveFormat);
        }

        private void CloseChunk(bool emitEvent)
        {
            var closedWriter = fileWriter;
            fileWriter = null;
            closedWriter?.Dispose();

            if (!emitEvent || currentPath is null || currentId is null)
            {
                return;
            }

            var endedAt = DateTimeOffset.UtcNow;
            var startMs = timelineStartMs;
            var endMs = startMs + Math.Max(0, (long)(endedAt - chunkStartedAt).TotalMilliseconds);
            timelineStartMs = endMs;

            if (totalBytes < MinChunkBytes || peakRms < SilenceRmsThreshold)
            {
                TryDelete(currentPath);
                writer.Write(new
                {
                    type = "runtime_status",
                    status = "silence_skipped",
                    source,
                    occurredAt = endedAt,
                    rms = peakRms
                });
                return;
            }

            writer.Write(new
            {
                type = "audio_chunk_ready",
                id = currentId,
                source,
                path = currentPath,
                startedAt = chunkStartedAt,
                endedAt,
                startMs,
                endMs,
                sampleRate = capture.WaveFormat.SampleRate,
                channels = capture.WaveFormat.Channels
            });
        }

        private void OnDataAvailable(object? sender, WaveInEventArgs args)
        {
            lock (gate)
            {
                if (fileWriter is null) return;
                fileWriter.Write(args.Buffer, 0, args.BytesRecorded);
                fileWriter.Flush();
                totalBytes += args.BytesRecorded;
                peakRms = Math.Max(peakRms, EstimateRms(args.Buffer, args.BytesRecorded, capture.WaveFormat));
            }
        }

        private void OnRecordingStopped(object? sender, StoppedEventArgs args)
        {
            if (args.Exception is null) return;
            writer.Write(new
            {
                type = "runtime_error",
                code = "track_capture_failed",
                message = args.Exception.Message,
                source,
                occurredAt = DateTimeOffset.UtcNow
            });
        }

        private static double EstimateRms(byte[] buffer, int bytesRecorded, WaveFormat format)
        {
            if (bytesRecorded <= 0) return 0;

            if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
            {
                double sum = 0;
                var samples = bytesRecorded / sizeof(float);
                for (var i = 0; i < samples; i++)
                {
                    var sample = BitConverter.ToSingle(buffer, i * sizeof(float));
                    sum += sample * sample;
                }
                return samples == 0 ? 0 : Math.Sqrt(sum / samples);
            }

            if (format.BitsPerSample == 16)
            {
                double sum = 0;
                var samples = bytesRecorded / sizeof(short);
                for (var i = 0; i < samples; i++)
                {
                    var sample = BitConverter.ToInt16(buffer, i * sizeof(short)) / 32768.0;
                    sum += sample * sample;
                }
                return samples == 0 ? 0 : Math.Sqrt(sum / samples);
            }

            return 1;
        }

        private static void TryDelete(string path)
        {
            try
            {
                File.Delete(path);
            }
            catch
            {
                // Best effort cleanup for silence chunks; never fail capture because cleanup failed.
            }
        }
    }
}
