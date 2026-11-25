// CloseAssist backend — concierge router endpoint.
// The in-app Concierge first tries its on-device router; free-form requests
// it can't place come here. Claude reads the message and returns a STRICT
// JSON intent ({reply, action}) which the app validates against a whitelist
// before acting — the model proposes, the app disposes. The concierge never
// sends, signs, pays, or deletes; write actions (CRM task/note) additionally
// require an explicit in-chat confirmation on the device.
//
// Same abuse floor as generate.js: non-secret client header, per-IP rate
// limit sized for a demo room, and a per-instance global ceiling as the
// cost backstop on the owner's key. Mitigation, not authentication.

import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const MODEL = process.env.MODEL || "claude-sonnet-4-6";

const APP_CLIENT = "closeassist-web";
const BUSY = "CloseAssist is getting a lot of use right this minute — wait a minute and try again.";
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
const GLOBAL = { hour: [], day: [] };
function globalCeiling(hourMax, dayMax) {
  const now = Date.now();
  GLOBAL.hour = GLOBAL.hour.filter((t) => now - t < 3600e3);
  GLOBAL.day = GLOBAL.day.filter((t) => now - t < 86400e3);
  if (GLOBAL.hour.length >= hourMax || GLOBAL.day.length >= dayMax) return true;
  GLOBAL.hour.push(now); GLOBAL.day.push(now);
  return false;
}
function corsOrigin(req) {
  if (process.env.ALLOWED_ORIGIN) return process.env.ALLOWED_ORIGIN;
  const o = req.headers.origin;
  if (!o) return "*";
  try { return new URL(o).host === req.headers.host ? o : "https://" + req.headers.host; } catch (e) { return "*"; }
}

// Tool ids the concierge may route to — mirrors the app's GROUPS tabs.
// The client re-validates against its own live list before navigating.
const TOOL_IDS = ["follow", "obj", "warm", "ref", "vm", "rev", "content", "engage", "mile", "hooks", "tot", "market", "news", "listing", "listpres", "cma", "price", "open", "prep", "offerbuild", "quick", "contract", "compare", "sign", "commission", "netsheet", "deadlines"];

const SYSTEM = [
  "You are the router for the CloseAssist concierge — an AI sales-desk app for Illinois real estate agents.",
  "Read the agent's latest message (with a little history) and respond with ONLY a JSON object — no prose, no code fences.",
  "",
  "Shape:",
  '{"reply": "<one or two warm, brief sentences in the agent\'s language>", "action": <action or null>}',
  "",
  "Actions (use null when none fits):",
  '- {"type":"navigate","target":"home"|"crm"|"crm-today"|"saved"|"brand"|"tool:<id>"} — open a screen. Tool ids: ' + TOOL_IDS.join(", ") + ".",
  '- {"type":"find_contact","query":"<name the agent mentioned>"} — find/open a CRM contact.',
  '- {"type":"draft","tool":"<id>","query":"<contact name or empty>"} — open a drafting tool, pre-filled when a contact is named.',
  '- {"type":"calculate","kind":"commission","params":{"price":300000,"pct":3}} — commission math.',
  '- {"type":"calculate","kind":"deadlines","params":{"accept":"YYYY-MM-DD","closing":"YYYY-MM-DD or empty","emDays":5}} — Multi-Board 8.0 deadlines from an acceptance date.',
  '- {"type":"calculate","kind":"proration","params":{"annualTax":6000,"months":7,"county":"Cook"}} — tax proration.',
  '- {"type":"today"} — what follow-ups are due today.',
  '- {"type":"listings"} — the agent wants to search live MLS listings.',
  '- {"type":"add_contact"} — the agent wants to add a new CRM contact.',
  "",
  "Rules:",
  "- The reply language matches the agent's message language (English or Spanish).",
  "- Never claim you sent a message, saved anything, or changed data — you only route. CRM writes happen on-device after the agent confirms.",
  "- If the agent asks you to send a text/email or contact someone, route to the closest draft action and say in the reply that you never send — they'll review and send in the tool.",
  "- Keep params numeric where shown. Dates as YYYY-MM-DD; resolve relative dates (\"today\", \"tomorrow\", \"next Friday\") against the provided current date.",
  "- If nothing fits, action is null and the reply briefly says what you CAN do (route, find contacts, draft, calculate, show what's due).",
].join("\n");

const ACTION_TYPES = ["navigate", "find_contact", "draft", "calculate", "today", "listings", "add_contact"];
function cleanAction(a) {
  if (!a || typeof a !== "object" || ACTION_TYPES.indexOf(a.type) < 0) return null;
  if (a.type === "navigate") {
    const t = String(a.target || "");
    if (["home", "crm", "crm-today", "saved", "brand"].indexOf(t) >= 0) return { type: "navigate", target: t };
    const m = t.match(/^tool:([a-z]+)$/);
    if (m && TOOL_IDS.indexOf(m[1]) >= 0) return { type: "navigate", target: t };
    return null;
  }
  if (a.type === "find_contact") return { type: "find_contact", query: String(a.query || "").slice(0, 60) };
  if (a.type === "draft") {
    if (TOOL_IDS.indexOf(a.tool) < 0) return null;
    return { type: "draft", tool: a.tool, query: String(a.query || "").slice(0, 60) };
  }
  if (a.type === "calculate") {
    const kinds = ["commission", "deadlines", "proration"];
    if (kinds.indexOf(a.kind) < 0) return null;
    const p = (a.params && typeof a.params === "object") ? a.params : {};
    const out = { type: "calculate", kind: a.kind, params: {} };
    for (const k of Object.keys(p).slice(0, 8)) {
      const v = p[k];
      if (typeof v === "number" && isFinite(v)) out.params[k] = v;
      else if (typeof v === "string") out.params[k] = v.slice(0, 40);
    }
    return out;
  }
  return { type: a.type };
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
  if (rateLimited(req, 180, 10 * 60 * 1000)) {
    return res.status(429).json({ error: BUSY });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });
  }

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const user = typeof data.user === "string" ? data.user.trim() : "";
    const lang = data.lang === "es" ? "es" : "en";
    const history = Array.isArray(data.history) ? data.history.slice(-6).map((h) => ({
      role: h && h.role === "assistant" ? "assistant" : "user",
      content: String((h && h.text) || "").slice(0, 500),
    })).filter((h) => h.content) : [];

    if (!user) return res.status(400).json({ error: "Missing 'user' message." });
    if (user.length > 4000) return res.status(400).json({ error: "Message too long (over 4,000 characters)." });

    if (globalCeiling(600, 4000)) {
      return res.status(429).json({ error: BUSY });
    }

    const today = new Date().toISOString().slice(0, 10);
    const convo = history.map((h) => (h.role === "assistant" ? "Concierge: " : "Agent: ") + h.content).join("\n");
    const prompt = "Current date: " + today + ". Agent language preference: " + (lang === "es" ? "Spanish" : "English") + "." +
      (convo ? "\n\nRecent conversation:\n" + convo : "") +
      "\n\nAgent's latest message: " + user +
      "\n\nRespond with ONLY the JSON object.";

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    let reply = "", action = null;
    try {
      const j = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
      reply = String(j.reply || "").slice(0, 600);
      action = cleanAction(j.action);
    } catch (e) {
      // Model answered in prose — pass it through as a plain reply, no action.
      reply = raw.slice(0, 600);
    }
    if (!reply && !action) return res.status(500).json({ error: "The concierge didn't answer — try again." });

    return res.status(200).json({ reply, action, model: MODEL });
  } catch (err) {
    const m = err?.error?.message || err?.message || "Server error.";
    return res.status(500).json({ error: m });
  }
}
