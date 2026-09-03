const SESSION_TOKEN_PREFIX = "cuemind_session_token_";
// Phase B：主界面写入最近会话 ID，/knowledge 管理页读取作为默认会话。
export const LAST_ACTIVE_SESSION_STORAGE_KEY = "cuemind_last_active_session";

export function storeLastActiveSessionId(sessionId: string | null | undefined): void {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    localStorage.setItem(LAST_ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // 存储溢出等：引导键写入失败不影响主流程。
  }
}

export function loadLastActiveSessionId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(LAST_ACTIVE_SESSION_STORAGE_KEY)?.trim() ?? "";
}

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
