using System.Text.Json;

namespace CueMind.Audio;

public sealed class JsonlEventWriter
{
    private readonly TextWriter output;
    private readonly JsonSerializerOptions options = new(JsonSerializerDefaults.Web);

    public JsonlEventWriter(TextWriter output)
    {
        this.output = output;
    }

    public void Write(object value)
    {
        output.WriteLine(JsonSerializer.Serialize(value, options));
        output.Flush();
    }
}
