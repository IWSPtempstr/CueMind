export async function generateOllamaJson<T>(args: {
  baseUrl: string;
  model: string;
  system: string;
  prompt: string;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(`${args.baseUrl.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        system: args.system,
        prompt: args.prompt,
        stream: false,
        format: "json",
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.response !== "string") {
      throw new Error("Ollama returned an invalid response");
    }
    try {
      return JSON.parse(payload.response) as T;
    } catch {
      throw new Error("Ollama returned non-JSON model output");
    }
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw new Error(`Ollama timed out after ${args.timeoutMs}ms`);
    }
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
