// CloseAssist backend — offer analysis endpoint.
// Receives already-extracted contract TEXT from the browser (small payloads),
// asks Claude to compare and rank the offers, returns the analysis.
//
// PDF text extraction happens in the browser (see /public/index.html) so this
// server stays tiny and cheap. Scanned PDFs (no embedded text) need OCR, which
// is a later add — they're flagged by the client before they ever reach here.

import Anthropic from "@anthropic-ai/sdk";

// Allow longer runs for the model call.
export const config = { maxDuration: 60 };

// Default model. Confirm the current string at https://docs.claude.com/en/docs/about-claude/models
// Cheaper option: set MODEL=claude-haiku-4-5-20251001 in your env to cut cost.
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

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  // Optional shared secret so randoms can't burn your API key.
  if (process.env.APP_SECRET && req.headers["x-app-key"] !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });
  }

  try {
    // Vercel parses JSON bodies automatically; guard just in case.
    const data = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { offers, priorities } = data;

    if (!Array.isArray(offers)) return res.status(400).json({ error: "Send an 'offers' array." });

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

    // Cap each contract's text so a giant doc can't blow up token cost.
    const body =
      (priorities ? `What the client cares about most: ${priorities}\n\n` : "") +
      usable.map((o) => `OFFER ${o.label} (${o.name}):\n${o.text.slice(0, 16000)}`).join("\n\n----\n\n");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2200,
      system: SYSTEM,
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
      model: MODEL,
    });
  } catch (err) {
    const msg = err?.error?.message || err?.message || "Server error.";
    return res.status(500).json({ error: msg });
  }
}
