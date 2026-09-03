import { NextResponse } from "next/server";

interface RateWindow {
  count: number;
  resetAt: number;
}

const RATE_WINDOW_MS = 60_000;
const globalRateLimit = globalThis as typeof globalThis & {
  cueMindRateLimits?: Map<string, RateWindow>;
};
const rateLimits =
  globalRateLimit.cueMindRateLimits ?? new Map<string, RateWindow>();
globalRateLimit.cueMindRateLimits = rateLimits;

function clientIp(request: Pick<Request, "headers">): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/**
 * Small per-instance safety net for deployments without an external limiter.
 * Multi-region production deployments should pair this with Vercel Firewall or
 * a shared store, but this still bounds bursts handled by each function instance.
 */
export function enforceRateLimit(
  request: Pick<Request, "headers">,
  bucket: string,
  limit: number,
): NextResponse<{ error: string }> | null {
  const now = Date.now();
  if (rateLimits.size > 10_000) {
    for (const [storedKey, window] of rateLimits) {
      if (window.resetAt <= now) rateLimits.delete(storedKey);
    }
  }
  const key = `${bucket}:${clientIp(request)}`;
  const current = rateLimits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return null;
  }

  current.count += 1;
  if (current.count <= limit) {
    return null;
  }

  return NextResponse.json(
    { error: "Too many requests. Please wait a moment and try again." },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))),
      },
    },
  );
}

export function cappedText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(-maxChars) : "";
}

export function cappedPrompt(
  value: unknown,
  fallback: string,
  maxChars: number,
): string {
  return typeof value === "string" && value.trim()
    ? value.slice(0, maxChars)
    : fallback;
}
