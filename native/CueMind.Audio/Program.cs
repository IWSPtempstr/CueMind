using CueMind.Audio;

var outputDir = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "cuemind-audio");
Directory.CreateDirectory(outputDir);

var writer = new JsonlEventWriter(Console.Out);
using var service = new AudioCaptureService(outputDir, writer);

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
