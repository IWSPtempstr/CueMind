using CueMind.Audio;

var outputDir = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "cuemind-audio");
Directory.CreateDirectory(outputDir);

var writer = new JsonlEventWriter(Console.Out);
var sources = ResolveSources(args, writer);
using var service = new AudioCaptureService(outputDir, writer, sources);

writer.Write(new
{
    type = "runtime_status",
    status = "starting",
    occurredAt = DateTimeOffset.UtcNow,
    outputDir
});

await service.StartAsync();

Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    service.Stop();
};

await service.Completion;

static string ResolveSources(string[] args, JsonlEventWriter writer)
{
    // argv 形如 [outputDir, --sources, mic|system|mixed]；缺省为 mixed，
    // 非法值回落 mixed 并写一条 runtime_error 事件（与前端 normalizeAudioSourceMode 的容错一致）。
    for (var index = 1; index < args.Length - 1; index++)
    {
        if (!string.Equals(args[index], "--sources", StringComparison.OrdinalIgnoreCase)) continue;

        var requested = args[index + 1];
        if (requested is "mic" or "system" or "mixed") return requested;

        writer.Write(new
        {
            type = "runtime_error",
            code = "invalid_sources_argument",
            message = $"Unknown --sources value '{requested}'; falling back to 'mixed'.",
            occurredAt = DateTimeOffset.UtcNow
        });
        return "mixed";
    }

    return "mixed";
}
