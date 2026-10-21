// CloseAssist -> Follow Up Boss connector.
// Actions (body.action), all POST:
//   "stages" -> list deal pipelines + stages (protected; app login required)
//   "lead"   -> send a new lead via /events (PUBLIC; used by the landing page)
//   "deal"   -> find-or-create person, then create a deal (protected)
//   "note"   -> find-or-create person, then add a note to their timeline (protected)
//   "task"   -> find-or-create person (optional), then create a task (protected)
//
// Auth to FUB: HTTP Basic, API key as username, blank password.
// Key: the caller's own FUB key (x-fub-key header, sent by the app when the
// agent connected theirs in the Muse drawer) wins; otherwise the server
// env var FUB_API_KEY (the CloseAssist account) is used.

export const config = { maxDuration: 30 };

const FUB_BASE = "https://api.followupboss.com/v1";

function fubHeaders(keyOverride) {
  const key = keyOverride || process.env.FUB_API_KEY || "";
  const basic = Buffer.from(key + ":").toString("base64");
  return {
    "Authorization": "Basic " + basic,
    "Content-Type": "application/json",
    "X-System": process.env.FUB_SYSTEM || "CloseAssist",
    ...(process.env.FUB_SYSTEM_KEY ? { "X-System-Key": process.env.FUB_SYSTEM_KEY } : {}),
  };
}

async function fubFetch(path, options = {}, keyOverride) {
  const res = await fetch(FUB_BASE + path, { ...options, headers: { ...fubHeaders(keyOverride), ...(options.headers || {}) } });
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
async function findOrCreatePerson({ name, email, phone, source, tags }, keyOverride) {
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
  }, keyOverride);
  if (!r.ok) throw new Error(fubErr(r, "Couldn't save contact in FUB."));
  return r.data;
}


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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-token, x-app-key, x-app-client, x-fub-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (req.headers["x-app-client"] !== APP_CLIENT) {
    return res.status(403).json({ error: "This endpoint only accepts requests from the CloseAssist app. If you're in the app, hard-refresh — your copy may be out of date." });
  }
  if (rateLimited(req, 60, 10 * 60 * 1000)) {
    return res.status(429).json({ error: "Lots of requests from your connection just now — wait a minute and try again." });
  }

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: "Bad request body." }); }

  const action = body.action || "deal";

  // Per-agent FUB key (BYOK): when the app sends the agent's own key, writes
  // land in THEIR Follow Up Boss. Otherwise the server env key (the
  // CloseAssist account) is used — the app UI labels that honestly.
  const callerKeyRaw = req.headers["x-fub-key"];
  const callerKey = (typeof callerKeyRaw === "string" && callerKeyRaw.length >= 8 && callerKeyRaw.length <= 200) ? callerKeyRaw : null;
  if (!callerKey && !process.env.FUB_API_KEY) {
    return res.status(500).json({ error: "No Follow Up Boss key available. Connect your own FUB key in the app (Muse drawer) — or the server needs FUB_API_KEY set." });
  }

  try {
    if (action === "stages") {
      const r = await fubFetch("/stages", {}, callerKey);
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
      }, callerKey);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't send lead.") });
      return res.status(200).json({ ok: true });
    }

    if (action === "deal") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.stageId) return res.status(400).json({ error: "Pick a deal stage." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: body.tags || ["CloseAssist"] }, callerKey);
      const r = await fubFetch("/deals", {
        method: "POST",
        body: JSON.stringify({
          name: body.dealName || body.propertyAddress || ("Deal — " + (body.name || "client")),
          stageId: Number(body.stageId),
          personId: person.id,
          ...(body.price ? { price: String(body.price) } : {}),
          ...(body.description ? { description: body.description } : {}),
        }),
      }, callerKey);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create deal in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id, dealId: r.data?.id });
    }

    if (action === "note") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.body || !String(body.body).trim()) return res.status(400).json({ error: "Nothing to log." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] }, callerKey);
      const r = await fubFetch("/notes", {
        method: "POST",
        body: JSON.stringify({
          personId: person.id,
          subject: body.subject || "CloseAssist draft",
          body: String(body.body).slice(0, 8000),
        }),
      }, callerKey);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't log note in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id });
    }

    if (action === "task") {
      if (!body.title || !String(body.title).trim()) return res.status(400).json({ error: "Give the task a title." });
      const person = (body.name || body.email || body.phone)
        ? await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] }, callerKey)
        : null;
      const r = await fubFetch("/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: String(body.title).slice(0, 200),
          ...(person ? { personId: person.id } : {}),
          ...(body.dueDate ? { dueDate: body.dueDate } : {}),
          ...(body.notes ? { notes: String(body.notes).slice(0, 2000) } : {}),
        }),
      }, callerKey);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create task in FUB.") });
      return res.status(200).json({ ok: true, taskId: r.data?.id });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error." });
  }
}
