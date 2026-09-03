import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_ACCESS_TOKEN_BYTES = 24;

export function generateSessionAccessToken(): string {
  return randomBytes(SESSION_ACCESS_TOKEN_BYTES).toString("base64url");
}

export function hashSessionAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifySessionAccessToken(token: string, expectedHash: string): boolean {
  if (!token || expectedHash.length !== 64) return false;
  const actual = Buffer.from(hashSessionAccessToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function readSessionAccessToken(headers: Headers): string {
  return headers.get("x-session-token")?.trim() ?? "";
}
