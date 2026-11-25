import crypto from "crypto";

const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

// Token payload: "<expiryMs>:<account>". The account segment was added
// 2026-11-25 for the two-login setup (owner / guest). Older tokens
// carry just the expiry and still verify — parseInt stops at the
// colon — and read as "owner" in accountOf.
export function sign(secret, ttlMs = THIRTY_DAYS, account = "owner") {
  const payload = String(Date.now() + ttlMs) + ":" + account;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

export function verify(secret, token) {
  if (!secret || !token || typeof token !== "string" || !token.includes(".")) return false;
  const parts = token.split(".");
  const b64 = parts[0];
  const sig = parts[1];
  let payload;
  try { payload = Buffer.from(b64, "base64url").toString("utf8"); } catch (e) { return false; }
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = parseInt(payload, 10);
  return !!exp && Date.now() <= exp;
}

// Which account a valid token belongs to: "owner" | "guest" | null.
export function accountOf(secret, token) {
  if (!verify(secret, token)) return null;
  try {
    const payload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    return payload.split(":")[1] === "guest" ? "guest" : "owner";
  } catch (e) { return null; }
}
