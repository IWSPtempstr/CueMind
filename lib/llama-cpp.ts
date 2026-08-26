import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  type JsonChatRequest,
} from "@/lib/model-provider";

/**
 * Local `llama.cpp`/`llama-server` provider. It wraps the shared
 * OpenAI-compatible JSON client and only supplies the `llama.cpp` identity.
 */
export async function generateLlamaCppJson<T>(
  args: Omit<JsonChatRequest, "provider">,
): Promise<T> {
  if (!args.baseUrl.trim() || !args.model.trim()) {
    throw new ModelProviderError({
      provider: "llama.cpp",
      code: "model_unreachable",
    });
  }
  return generateOpenAiCompatibleJson<T>({ provider: "llama.cpp", ...args });
}
