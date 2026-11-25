// Password login — two accounts (2026-11-25):
//   APP_PASSWORD        → "owner"  (Miguel's personal/demo account;
//                                   comma-separate for extra owner passwords)
//   APP_PASSWORD_GUEST  → "guest"  (one shared password for everyone else
//                                   until real per-agent accounts land;
//                                   comma-separate to allow rotation overlap)
// On success returns a signed token carrying the account; the app uses
// the account to partition on-device data (owner keeps the legacy
// storage keys, guest gets a clean namespaced workspace). If
// APP_PASSWORD_GUEST is not set, guest logins simply fail — owner
// login is unaffected.

import { sign } from "../lib/auth.js";

export const config = { maxDuration: 10 };

function passList(envVal) {
  return (envVal || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const secret = process.env.APP_SECRET;
  if (!secret) return res.status(500).json({ error: "Server missing APP_SECRET." });

  const owners = passList(process.env.APP_PASSWORD);
  const guests = passList(process.env.APP_PASSWORD_GUEST);
  if (!owners.length && !guests.length) return res.status(500).json({ error: "No APP_PASSWORD set on the server." });

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const password = (data.password || "").trim();
    if (!password) return res.status(401).json({ error: "Incorrect password." });
    if (owners.includes(password)) return res.status(200).json({ token: sign(secret, undefined, "owner"), account: "owner" });
    if (guests.includes(password)) return res.status(200).json({ token: sign(secret, undefined, "guest"), account: "guest" });
    return res.status(401).json({ error: "Incorrect password." });
  } catch {
    return res.status(400).json({ error: "Bad request." });
  }
}
