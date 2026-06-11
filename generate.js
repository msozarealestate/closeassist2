// CloseAssist backend — general text-generation endpoint.
// All the everyday CloseAssist tools (follow-ups, posts, contracts, etc.)
// send their {system, user} prompt here; this calls Claude with YOUR key
// and returns the text. Same shape as analyze.js, just general-purpose.

import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const MODEL = process.env.MODEL || "claude-sonnet-4-6";

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (process.env.APP_SECRET && req.headers["x-app-key"] !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
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
