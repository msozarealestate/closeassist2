// Tiny token auth — no database needed.
// A successful password login returns a signed, expiring token.
// The signing secret (APP_SECRET) never leaves the server.

import crypto from "crypto";

const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

export function sign(secret, ttlMs = THIRTY_DAYS) {
  const payload = String(Date.now() + ttlMs); // expiry timestamp
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

export function verify(secret, token) {
  if (!secret || !token || typeof token !== "string" || !token.
