// CloseAssist -> Follow Up Boss connector.
// Actions (body.action), all POST:
//   "status"     -> how the caller is connected (OAuth login / own key /
//                   server account / nothing) — no FUB write
//   "disconnect" -> revoke + clear the OAuth login cookies
//   "stages" -> list deal pipelines + stages (protected; app login required)
//   "lead"   -> send a new lead via /events (PUBLIC; used by the landing page)
//   "deal"   -> find-or-create person, then create a deal (protected)
//   "note"   -> find-or-create person, then add a note to their timeline (protected)
//   "task"   -> find-or-create person (optional), then create a task (protected)
//
// Auth to FUB, in order:
//   1. OAuth login (2026-11-25): the agent connected via FUB's own login
//      page (api/fub-auth.js + api/fub-callback.js); tokens ride in
//      HttpOnly cookies bound to the caller's CloseAssist account.
//      API calls use Bearer auth; an expired access token is refreshed
//      transparently (refresh tokens live 90 days unused).
//   2. The caller's own FUB API key (x-fub-key header, HTTP Basic) —
//      the original connect path, kept as a fallback.
//   3. The server env var FUB_API_KEY (the CloseAssist account).

import { accountOf } from "../lib/auth.js";

export const config = { maxDuration: 30 };

const FUB_BASE = "https://api.followupboss.com/v1";
const FUB_TOKEN_URL = "https://app.followupboss.com/oauth/token";

function fubHeaders(cred) {
  const auth = cred && cred.bearer
    ? "Bearer " + cred.bearer
    : "Basic " + Buffer.from(((cred && cred.key) || process.env.FUB_API_KEY || "") + ":").toString("base64");
  return {
    "Authorization": auth,
    "Content-Type": "application/json",
    "X-System": process.env.FUB_SYSTEM || "CloseAssist",
    ...(process.env.FUB_SYSTEM_KEY ? { "X-System-Key": process.env.FUB_SYSTEM_KEY } : {}),
  };
}

async function fubFetch(path, options = {}, cred = {}) {
  const attempt = async (bearer) => {
    const res = await fetch(FUB_BASE + path, { ...options, headers: { ...fubHeaders({ ...cred, bearer }), ...(options.headers || {}) } });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  };
  let r = await attempt(cred.bearer);
  // OAuth access tokens live 60 minutes; on a 401, refresh once and retry.
  if (r.status === 401 && cred.bearer && cred.refresh) {
    const fresh = await cred.refresh();
    if (fresh) r = await attempt(fresh);
  }
  return r;
}

// ── OAuth token cookies ──────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  const raw = (req.headers && req.headers.cookie) || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}
function tokenCookie(name, value, maxAge) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";
}
function oauthCookieSet(at, rt, acct, expiresIn) {
  return [
    tokenCookie("ca_fub_at", at, Number(expiresIn) || 3600),
    tokenCookie("ca_fub_rt", rt, 90 * 24 * 3600),
    tokenCookie("ca_fub_acct", acct, 90 * 24 * 3600),
  ];
}
function oauthCookieClear() {
  return ["ca_fub_at", "ca_fub_rt", "ca_fub_acct"].map((n) => tokenCookie(n, "", 0));
}
async function refreshFubTokens(rt) {
  const clientId = process.env.FUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.FUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !rt) return null;
  try {
    const r = await fetch(FUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }).toString(),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.access_token) return null;
    return { at: data.access_token, rt: data.refresh_token || rt, expiresIn: data.expires_in };
  } catch { return null; }
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
async function findOrCreatePerson({ name, email, phone, source, tags }, cred) {
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
  }, cred);
  if (!r.ok) throw new Error(fubErr(r, "Couldn't save contact in FUB."));
  return r.data;
}


// ── abuse floor (open tester rollout — no user-facing auth by design) ──
// Best-effort floors, NOT real authentication: a non-secret client header
// the app sends (stops casual curl/scanner use; anyone reading the page
// source can copy it), rate limiting, and CORS restricted to the app's
// own origin unless ALLOWED_ORIGIN is set.
//
// Rate-limit shape (round 3): per-IP limits are deliberately DEMO-SAFE —
// an office or pitch room behind one NAT shares a single bucket, so the
// ceiling is sized for a roomful of agents. A per-instance GLOBAL
// ceiling (hourly + daily) backs it up as a write-spam backstop for the
// CRM accounts this endpoint can write to. Honest limits: counters are
// in-memory per warm instance, so ceilings are per-instance, not
// fleet-wide. Mitigation, not authentication.
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
  if (rateLimited(req, 300, 10 * 60 * 1000)) {
    return res.status(429).json({ error: BUSY });
  }
  if (globalCeiling(1000, 6000)) {
    return res.status(429).json({ error: BUSY });
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

  // OAuth login: tokens in cookies, bound to the CloseAssist account
  // that connected them. A valid app token naming a DIFFERENT account
  // (owner vs guest on a shared browser) never sees the connection.
  const cookies = parseCookies(req);
  const tokenAcct = accountOf(process.env.APP_SECRET, req.headers["x-app-token"]);
  const oauthBound = !!(cookies.ca_fub_rt && cookies.ca_fub_acct && tokenAcct && cookies.ca_fub_acct === tokenAcct);
  let oauthAt = oauthBound ? (cookies.ca_fub_at || null) : null;
  const cred = { key: callerKey };
  if (oauthBound) {
    cred.refresh = async () => {
      const t = await refreshFubTokens(cookies.ca_fub_rt);
      if (!t) return null;
      oauthAt = t.at;
      res.setHeader("Set-Cookie", oauthCookieSet(t.at, t.rt, tokenAcct, t.expiresIn));
      return t.at;
    };
    if (!oauthAt) oauthAt = await cred.refresh();
    if (oauthAt) cred.bearer = oauthAt;
  }

  try {
    if (action === "status") {
      if (cred.bearer) {
        let label = "";
        try {
          const idr = await fubFetch("/identity", {}, cred);
          if (idr.ok) {
            const u = idr.data && idr.data.user;
            const a = idr.data && idr.data.account;
            label = (u && (u.name || u.email)) || (a && a.name) || "";
          }
        } catch { /* identity is a nicety; connected stands without it */ }
        return res.status(200).json({ connected: true, via: "oauth", label });
      }
      if (callerKey) return res.status(200).json({ connected: true, via: "key" });
      if (process.env.FUB_API_KEY) return res.status(200).json({ connected: false, via: "server" });
      return res.status(200).json({ connected: false, via: null });
    }

    if (action === "disconnect") {
      if (cookies.ca_fub_rt || cookies.ca_fub_at) {
        if (cookies.ca_fub_at && process.env.FUB_SYSTEM_KEY) {
          try {
            await fetch(FUB_BASE + "/oauthApps/revokeAccess", {
              method: "DELETE",
              headers: {
                "Authorization": "Basic " + cookies.ca_fub_at,
                "X-System": process.env.FUB_SYSTEM || "CloseAssist",
                "X-System-Key": process.env.FUB_SYSTEM_KEY,
              },
            });
          } catch { /* revocation is best-effort; clearing cookies disconnects locally regardless */ }
        }
        res.setHeader("Set-Cookie", oauthCookieClear());
      }
      return res.status(200).json({ ok: true });
    }

    if (!cred.bearer && !callerKey && !process.env.FUB_API_KEY) {
      return res.status(500).json({ error: "No Follow Up Boss connection available. Connect your Follow Up Boss in the app (Muse drawer) — or the server needs FUB_API_KEY set." });
    }

    if (action === "stages") {
      const r = await fubFetch("/stages", {}, cred);
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
      }, cred);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't send lead.") });
      return res.status(200).json({ ok: true });
    }

    if (action === "deal") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.stageId) return res.status(400).json({ error: "Pick a deal stage." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: body.tags || ["CloseAssist"] }, cred);
      const r = await fubFetch("/deals", {
        method: "POST",
        body: JSON.stringify({
          name: body.dealName || body.propertyAddress || ("Deal — " + (body.name || "client")),
          stageId: Number(body.stageId),
          personId: person.id,
          ...(body.price ? { price: String(body.price) } : {}),
          ...(body.description ? { description: body.description } : {}),
        }),
      }, cred);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create deal in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id, dealId: r.data?.id });
    }

    if (action === "note") {
      if (!body.name && !body.email && !body.phone) return res.status(400).json({ error: "Add at least a name, email, or phone." });
      if (!body.body || !String(body.body).trim()) return res.status(400).json({ error: "Nothing to log." });
      const person = await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] }, cred);
      const r = await fubFetch("/notes", {
        method: "POST",
        body: JSON.stringify({
          personId: person.id,
          subject: body.subject || "CloseAssist draft",
          body: String(body.body).slice(0, 8000),
        }),
      }, cred);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't log note in FUB.") });
      return res.status(200).json({ ok: true, personId: person.id });
    }

    if (action === "task") {
      if (!body.title || !String(body.title).trim()) return res.status(400).json({ error: "Give the task a title." });
      const person = (body.name || body.email || body.phone)
        ? await findOrCreatePerson({ name: body.name, email: body.email, phone: body.phone, tags: ["CloseAssist"] }, cred)
        : null;
      const r = await fubFetch("/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: String(body.title).slice(0, 200),
          ...(person ? { personId: person.id } : {}),
          ...(body.dueDate ? { dueDate: body.dueDate } : {}),
          ...(body.notes ? { notes: String(body.notes).slice(0, 2000) } : {}),
        }),
      }, cred);
      if (!r.ok) return res.status(r.status).json({ error: fubErr(r, "Couldn't create task in FUB.") });
      return res.status(200).json({ ok: true, taskId: r.data?.id });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Server error." });
  }
}
