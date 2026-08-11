import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { enforceRateLimit, resolveGroqApiKey } from "@/lib/api-security";

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

export async function GET(
  request: NextRequest,
): Promise<NextResponse<{ valid: true } | { error: string }>> {
  const limited = enforceRateLimit(request, "validate-key", 10);
  if (limited) return limited;

  const apiKey = resolveGroqApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: "No API key provided" }, { status: 401 });
  }

  try {
    const response = await fetch(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 401 ? "That key was rejected by Groq" : "Could not validate key" },
        { status: response.status },
      );
    }
    return NextResponse.json({ valid: true });
  } catch {
    return NextResponse.json({ error: "Could not reach Groq" }, { status: 502 });
  }
}
