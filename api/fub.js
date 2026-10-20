// CloseAssist -> Follow Up Boss connector.
// Actions (body.action), all POST:
//   "stages" -> list deal pipelines + stages (protected; app login required)
//   "lead"   -> send a new lead via /events (PUBLIC; used by the landing page)
//   "deal"   -> find-or-create person, then create a deal (protected)
//   "note"   -> find-or-create person, then add a note to their timeline (protected)
//   "task"   -> find-or-create person (optional), then create a task (protected)
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

function fubErr(r, fallback) {
  return r.data?.errorMessage || r.data?.message || r.data?.error || fallback;
}

function splitName(full) {
  const parts = (full || "").trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// Find-or-create: POST /v1/people merges on matching email/phone automatically,
// so this never creates duplicates when contact info is provided.
async function findOrCreatePerson({ name, email, phone, source, tags }) {
  const { firstName, lastName } = splitName(name);
  const r = await fubFetch("/people", {
    method: "POST",
    body: JSON.stringify({
      firstName,
      lastName,
      emails: email ? [{ value: email }] : [],
      phones: phone ? [{ value: phone }] : [],
      source: source || "CloseAssist",
      ...(tags && tags.length ? { tags } : {}),
    }),
  });
  if (!r.ok) throw new Error(fubErr(r, "Couldn't save contact in FUB."));
  return r.data;
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

  // NOTE: auth removed for the open tester rollout (2026-10-19).
  // All actions (including FUB writes) are open to anyone with the URL.
  if (!process.env.FUB_API_KEY) {
    return res.status(500).json({ error: "Server missing FUB_API_KEY. Add it in Vercel and redeploy." });
  }

  try {
    if (action === "stages") {
      const r = await fubFetch("/stages");
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't load stages from FUB.") });
      const stages = (r.data?.stages || []).map((s) => ({ id: s.id, name: s.name, pipelineId: s.pipelineId }));
      return res.status(200).json({ stages });
    }

    if (action === "lead") {
      const { firstName, lastName } = splitName(body.name);
      const r = await fubFetch("/events", {
        method: "POST",
        body: JSON.stringify({
          type: body.type || "Seller Inquiry",
          source: body.source || "CloseAssist Landing Page",
          firstName,
          lastName,
          email: body.email || undefined,
          phone: body.phone || undefined,
          propertyAddress: body.propertyAddress || undefined,
          message: body.message || undefined,
          tags: body.tags || ["CloseAssist"],
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't send lead.") });
      return res.status(200).json({ ok: true });
    }

    if (action === "deal") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.stageId) return res.status(400).json({ error: "Pick a deal stage." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: body.tags || ["CloseAssist"] });
      const r = await fubFetch("/deals", {
        method: "POST",
        body: JSON.stringify({
          name: body.dealName || body.propertyAddress || ("Deal — " + (body.name || "client")),
          stageId: Number(body.stageId),
          personId: person.id,
          ...(body.price ? { price: String(body.price) } : {}),
          ...(body.description ? { description: body.description } : {}),
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create deal in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id, dealId: r.data?.id });
    }

    if (action === "note") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.body || !String(body.body).trim()) return res.status(400).json({ error: "Nothing to log." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] });
      const r = await fubFetch("/notes", {
        method: "POST",
        body: JSON.stringify({
          personId: person.id,
          subject: body.subject || "CloseAssist draft",
          body: String(body.body).slice(0, 8000),
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't log note in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id });
    }

    if (action === "task") {
      if (!body.title || !String(body.title).trim()) return res.status(400).json({ error: "Give the task a title." });
      const person = (body.name || body.email || body.phone)
        ? await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] })
        : null;
      const r = await fubFetch("/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: String(body.title).slice(0, 200),
          ...(person ? { personId: person.id } : {}),
          ...(body.dueDate ? { dueDate: body.dueDate } : {}),
          ...(body.notes ? { notes: String(body.notes).slice(0, 2000) } : {}),
        }),
      });
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create task in FUB.") });
      return res.status(200).json({ ok: true, taskId: r.data?.id });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error." });
  }
}
