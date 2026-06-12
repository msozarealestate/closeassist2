// CloseAssist -> Follow Up Boss connector.
// Actions (body.action):
//   "stages"  -> list deal pipelines + stages (protected; app login required)
//   "lead"    -> send a new lead via /events (PUBLIC; used by the landing page)
//   "deal"    -> create/find person, then create a deal (protected)
//
// Auth to FUB: HTTP Basic, API key as username, blank password.
// Key lives ONLY on the server as env var FUB_API_KEY.

import { verify } from "../lib/auth.js";

export const config = { maxDuration: 30 };

const FUB_BASE = "https://api.followupboss.com/v1";

function fubHeaders() {
  const key = process.env.FUB_API_KEY || "";
  const basic = Buffer.from(key + ":").toString("base64");
  return {
    "Authorization": "Basic " + basic,
    "Content-Type": "application/json",
    "X-System": process.env.FUB_SYSTEM || "CloseAssist",
    ...(process.env.FUB_SYSTEM_KEY ? { "X-System-Key": process.env.FUB_SYSTEM_KEY } : {}),
  };
}

async function fubFetch(path, options = {}) {
  const res = await fetch(FUB_BASE + path, { ...options, headers: { ...fubHeaders(), ...(options.headers || {}) } });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function splitName(full) {
  const parts = (full || "").trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-token, x-app-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: "Bad request body." }); }

  const action = body.action || "deal";

  // The public lead-capture form posts { action: "lead" } with no login token.
  // That's allowed (it can only create a lead). Everything else requires the app token.
  if (action !== "lead") {
    const secret = process.env.APP_SECRET;
    if (secret) {
      const ok = req.headers["x-app-key"] === secret || verify(secret, req.headers["x-app-token"]);
      if (!ok) return res.status(401).json({ error: "Unauthorized." });
    }
  }
  if (!process.env.FUB_API_KEY) {
    return res.status(500).json({ error: "Server missing FUB_API_KEY. Add it in Vercel and redeploy." });
  }

  try {
    if (action === "stages") {
      const r = await fubFetch("/stages");
      if (!r.ok) return res.status(r.status).json({ error: r.data?.errorMessage || "Couldn't load stages from FUB." });
      const stages = (r.data?.stages || []).map((s) => ({ id: s.id, name: s.name, pipelineId: s.pipelineId }));
      return res.status(200).json({ stages });
    }

    const { firstName, lastName } = splitName(body.name);
    const emails = body.email ? [{ value: body.email }] : [];
    const phones = body.phone ? [{ value: body.phone }] : [];

    if (action === "lead") {
