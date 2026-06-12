// CloseAssist -> Follow Up Boss connector.
// Three actions (pick with body.action):
//   "stages"  -> list your deal pipelines + stages (so the app can show a picker)
//   "lead"    -> send a new lead the RIGHT way, via /events (creates person + fires action plans)
//   "deal"    -> create/find the person, then create a deal in a chosen stage
//                (a deal is what the FUB->dotloop integration uses to create the loop)
//
// Auth to FUB: HTTP Basic, API key as username, blank password.
// The key lives ONLY on the server as env var FUB_API_KEY.
// This endpoint itself is protected by the same login token as the rest of the app.

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

  const secret = process.env.APP_SECRET;
  if (secret) {
    const ok = req.headers["x-app-key"] === secret || verify(secret, req.headers["x-app-token"]);
    if (!ok) return res.status(401).json({ error: "Unauthorized." });
  }
  if (!process.env.FUB_API_KEY) {
    return res.status(500).json({ error: "Server missing FUB_API_KEY. Add it in Vercel and redeploy." });
  }

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: "Bad request body." }); }

  const action = body.action || "deal";

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
      if (!firstName && !emails.length && !phones.length) {
        return res.status(400).json({ error: "Add at least a name, email, or phone." });
      }
      const payload = {
        source: body.source || "CloseAssist",
        system: process.env.FUB_SYSTEM || "CloseAssist",
        type: body.type || "General Inquiry",
        message: body.message || "",
        person: { firstName, lastName, emails, phones, tags: body.tags || ["CloseAssist"] },
      };
      if (body.propertyAddress) {
        payload.property = { street: body.propertyAddress, mlsNumber: body.mls || undefined };
        if (payload.type === "General Inquiry") payload.type = "Property Inquiry";
      }
      const r = await fubFetch("/events", { method: "POST", body: JSON.stringify(payload) });
      if (r.status === 204) return res.status(200).json({ ok: true, note: "Accepted, but this source's lead flow is archived in FUB." });
      if (!r.ok) return res.status(r.status).json({ error: r.data?.errorMessage || "FUB rejected the lead." });
      return res.status(200).json({ ok: true, person: r.data?.person || null });
    }

    if (action === "deal") {
      if (!body.stageId) return res.status(400).json({ error: "Pick a deal stage first." });

      let personId = body.personId || null;
      if (!personId && body.email) {
        const look = await fubFetch("/people?email=" + encodeURIComponent(body.email) + "&limit=1");
        if (look.ok && look.data?.people?.length) personId = look.data.people[0].id;
      }
      if (!personId) {
        const create = await fubFetch("/people", {
          method: "POST",
          body: JSON.stringify({ firstName, lastName, emails, phones, tags: body.tags || ["CloseAssist"] }),
        });
        if (!create.ok) return res.status(create.status).json({ error: create.data?.errorMessage || "Couldn't create the contact in FUB." });
        personId = create.data?.id;
      }

      const dealPayload = {
        name: body.dealName || body.propertyAddress || "New CloseAssist deal",
        stageId: body.stageId,
        personId,
      };
      if (body.price) {
        const num = Number(String(body.price).replace(/[^0-9.]/g, ""));
        if (num) dealPayload.price = num;
      }
      if (body.description) dealPayload.description = body.description;

      const deal = await fubFetch("/deals", { method: "POST", body: JSON.stringify(dealPayload) });
      if (!deal.ok) return res.status(deal.status).json({ error: deal.data?.errorMessage || "Contact saved, but the deal failed to create.", personId });
      return res.status(200).json({ ok: true, personId, deal: deal.data || null });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error talking to Follow Up Boss." });
  }
}
