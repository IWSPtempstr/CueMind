const SESSION_TOKEN_PREFIX = "cuemind_session_token_";

function storageKey(sessionId: string): string {
  return `${SESSION_TOKEN_PREFIX}${sessionId}`;
}

export function generateClientSessionAccessToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function loadSessionAccessToken(sessionId: string | null | undefined): string {
  if (typeof window === "undefined" || !sessionId) return "";
  return localStorage.getItem(storageKey(sessionId)) ?? "";
}

export function storeSessionAccessToken(sessionId: string, token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(storageKey(sessionId), token);
}

export function clearSessionAccessToken(sessionId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(storageKey(sessionId));
}

export function withSessionHeaders(sessionId: string | null | undefined, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  const token = loadSessionAccessToken(sessionId);
  if (token) next.set("X-Session-Token", token);
  return next;
}
