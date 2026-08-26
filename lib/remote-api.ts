import {
  ModelProviderError,
  generateOpenAiCompatibleJson,
  type JsonChatRequest,
} from "@/lib/model-provider";

/**
 * Explicitly configured OpenAI-compatible remote API provider. It wraps the
 * shared JSON client and only supplies the `remote-api` identity.
 */
export async function generateRemoteApiJson<T>(
  args: Omit<JsonChatRequest, "provider">,
): Promise<T> {
  if (!args.baseUrl.trim() || !args.model.trim()) {
    throw new ModelProviderError({
      provider: "remote-api",
      code: "model_unreachable",
    });
  }
  return generateOpenAiCompatibleJson<T>({ provider: "remote-api", ...args });
}
