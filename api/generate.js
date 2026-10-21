// CloseAssist backend — general text-generation endpoint.
// All the everyday CloseAssist tools (follow-ups, posts, contracts, etc.)
// send their {system, user} prompt here; this calls Claude with YOUR key
// and returns the text. Same shape as analyze.js, just general-purpose.

import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const MODEL = process.env.MODEL || "claude-sonnet-4-6";


// ── abuse floor (open tester rollout — no user-facing auth by design) ──
// Best-effort floors, NOT real authentication: a non-secret client header
// the app sends (stops casual curl/scanner use; anyone reading the page
// source can copy it), per-IP in-memory rate limiting (per warm function
// instance), input length caps, a server-side max_tokens clamp, and CORS
// restricted to the app's own origin unless ALLOWED_ORIGIN is set.
const APP_CLIENT = "closeassist-web";
const RL = new Map();
function rateLimited(req, max, windowMs) {
  const now = Date.now();
  if (RL.size > 5000) RL.clear();
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
  const hits = (RL.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  RL.set(ip, hits);
  return hits.length > max;
}
function corsOrigin(req) {
  if (process.env.ALLOWED_ORIGIN) return process.env.ALLOWED_ORIGIN;
  const o = req.headers.origin;
  if (!o) return "*";
  try { return new URL(o).host === req.headers.host ? o : "https://" + req.headers.host; } catch (e) { return "*"; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin(req));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key, x-app-token, x-app-client");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (req.headers["x-app-client"] !== APP_CLIENT) {
    return res.status(403).json({ error: "This endpoint only accepts requests from the CloseAssist app. If you're in the app, hard-refresh — your copy may be out of date." });
  }
  if (rateLimited(req, 40, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Lots of requests from your connection just now — wait a minute and try again." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });
  }

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const system = typeof data.system === "string" ? data.system : "";
    const user = typeof data.user === "string" ? data.user : "";
    const maxTokens = Math.min(Math.max(parseInt(data.max_tokens, 10) || 1200, 100), 4000);

    if (!user.trim()) return res.status(400).json({ error: "Missing 'user' prompt." });
    if (system.length > 20000) return res.status(400).json({ error: "Prompt too long (system section over 20,000 characters)." });
    if (user.length > 60000) return res.status(400).json({ error: "Prompt too long (over 60,000 characters). Trim the input and try again." });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: [{ role: "user", content: user }],
    });

    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return res.status(200).json({ text, model: MODEL });
  } catch (err) {
    const m = err?.error?.message || err?.message || "Server error.";
    return res.status(500).json({ error: m });
  }
}
