import assert from "node:assert/strict";
import { generateSessionAccessToken, hashSessionAccessToken, verifySessionAccessToken } from "@/lib/session-auth";

const token = generateSessionAccessToken();
assert.equal(typeof token, "string");
assert.ok(token.length >= 32);
const hash = hashSessionAccessToken(token);
assert.equal(hash.length, 64);
assert.equal(verifySessionAccessToken(token, hash), true);
assert.equal(verifySessionAccessToken(`${token}x`, hash), false);
assert.equal(verifySessionAccessToken(token, "0".repeat(64)), false);
console.log("session auth regression passed");
