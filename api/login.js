// Password login. Checks the submitted password against APP_PASSWORD
// (comma-separate multiple passwords to give different people their own),
// and on success returns a signed token the app uses for every request.

import { sign } from "../lib/auth.js";

export const config = { maxDuration: 10 };

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const secret = process.env.APP_SECRET;
  if (!secret) return res.status(500).json({ error: "Server missing APP_SECRET." });

  const allowed = (process.env.APP_PASSWORD || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return res.status(500).json({ error: "No APP_PASSWORD set on the server." });

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const password = (data.password || "").trim();
    if (!password || !allowed.includes(password)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    return res.status(200).json({ token: sign(secret) });
  } catch {
    return res.status(400).json({ error: "Bad request." });
  }
}
