import crypto from "crypto";

const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

export function sign(secret, ttlMs = THIRTY_DAYS) {
  const payload = String(Date.now() + ttlMs);
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
