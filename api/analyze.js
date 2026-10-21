// CloseAssist backend — offer analysis endpoint.
// Receives already-extracted contract TEXT from the browser (small payloads),
// asks Claude to compare and rank the offers, returns the analysis.

import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const MODEL = process.env.MODEL || "claude-sonnet-4-6";

const SYSTEM = `You are an expert listing-side real estate advisor helping an agent decide which offer to present to their SELLER client.

For EACH offer, extract and compare the terms that decide a winner:
- Purchase price
- Financing type and strength (cash / conventional / FHA / VA; pre-approval or proof of funds)
- Earnest money (amount and % of price)
- Inspection request / contingency and its timeline
- Financing and appraisal contingencies; any appraisal-gap coverage
- Closing date and overall speed/certainty
- Seller concessions or credits requested (and their dollar impact)
- Possession terms (e.g. rent-back)
- Any red flags, weak spots, or unusual conditions

Then:
1. Give a tight side-by-side comparison (use a simple text table or aligned columns).
2. RANK the offers best-to-worst FOR THE SELLER, explaining the tradeoffs. Remember the highest price is not automatically best — certainty, clean terms, financing strength, and speed matter, and concessions reduce net proceeds.
3. Clearly name the ONE offer to lead with and a strong backup, with one sentence on why each.
4. End with a 2-3 sentence plain-English summary the agent can say to their client.

Weigh the client's stated priorities if provided. Be well-organized with short headers. This analysis informs the agent's judgment — it is NOT legal or financial advice, and the agent must verify every term against the actual signed documents.`;


// ── abuse floor (open tester rollout — no user-facing auth by design) ──
// Best-effort floors, NOT real authentication: a non-secret client header
// the app sends (stops casual curl/scanner use; anyone reading the page
// source can copy it), rate limiting, input length caps, a server-side
// max_tokens clamp, and CORS restricted to the app's own origin unless
// ALLOWED_ORIGIN is set.
//
// Rate-limit shape (round 3): per-IP limits are deliberately DEMO-SAFE —
// a brokerage office or pitch room behind one NAT shares a single
// bucket, so the per-IP ceiling is sized for a roomful of agents, not
// one person. The cost backstop on the owner's key is the per-instance
// GLOBAL ceiling (hourly + daily), counted only for shared-key analyses
// (caller-key/BYOK analyses don't spend the owner's key). Honest limits:
// counters are in-memory per warm instance, so ceilings are
// per-instance, not fleet-wide. Mitigation, not authentication.
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key, x-app-token, x-app-client, x-anthropic-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (req.headers["x-app-client"] !== APP_CLIENT) {
    return res.status(403).json({ error: "This endpoint only accepts requests from the CloseAssist app. If you're in the app, hard-refresh — your copy may be out of date." });
  }
  if (rateLimited(req, 120, 10 * 60 * 1000)) {
    return res.status(429).json({ error: BUSY });
  }

  // Caller key (BYOK): Offer Compare's upload mode runs on the agent's own
  // Anthropic key when they connected one — sent per-request, never stored.
  const callerKey = req.headers["x-anthropic-key"];
  if (callerKey !== undefined && !(typeof callerKey === "string" && callerKey.indexOf("sk-ant-") === 0)) {
    return res.status(400).json({ error: "That Anthropic key doesn't look right — reconnect it in the Muse drawer." });
  }
  const apiKey = callerKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });
  }

  try {
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { offers, priorities, lang } = data;
    const langInstruct = lang === "es" ? "\n\nWrite your entire response in Spanish (neutral Latin American Spanish, warm and professional, appropriate for US Hispanic real estate clients). Keep proper names, addresses, and numbers as-is." : "";

    if (!Array.isArray(offers)) return res.status(400).json({ error: "Send an 'offers' array." });
    if (offers.some((o) => String((o && o.text) || "").length > 400000)) {
      return res.status(400).json({ error: "One of those files is too large to analyze (over ~400,000 characters of extracted text)." });
    }

    const usable = offers
      .map((o, i) => ({
        label: String.fromCharCode(65 + i),
        name: (o && o.name) || `Offer ${String.fromCharCode(65 + i)}`,
        text: ((o && o.text) || "").trim(),
      }))
      .filter((o) => o.text.length > 40);

    if (usable.length < 2) {
      return res.status(422).json({
        error: "Need at least two offers with readable text. Files with no extractable text are likely scanned PDFs (OCR not supported yet).",
      });
    }
    if (usable.length > 12) return res.status(400).json({ error: "Max 12 offers per batch." });

    // Global per-instance ceiling — the cost backstop on the owner's key.
    // Only shared-key analyses count; a caller's own key spends their money.
    if (!callerKey && globalCeiling(300, 1500)) {
      return res.status(429).json({ error: BUSY });
    }

    // Offers are sliced to 16k chars for the model — say which ones, so the
    // agent knows the comparison didn't see the whole document.
    const truncated = usable.filter((o) => o.text.length > 16000).map((o) => o.name);

    const body =
      (priorities ? `What the client cares about most: ${priorities}\n\n` : "") +
      usable.map((o) => `OFFER ${o.label} (${o.name}):\n${o.text.slice(0, 16000)}`).join("\n\n----\n\n");

    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM + langInstruct,
      messages: [{ role: "user", content: body }],
    });

    const analysis = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return res.status(200).json({
      analysis,
      read: usable.map((o) => ({ label: o.label, name: o.name })),
      truncated,
      model: MODEL,
    });
  } catch (err) {
    const msg = err?.error?.message || err?.message || "Server error.";
    return res.status(500).json({ error: msg });
  }
}
