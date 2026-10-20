// CloseAssist MCP server — exposes CloseAssist's real-estate tools to any MCP client
// (Claude Desktop, Claude Code, etc.) via Streamable HTTP.
//
// URL: https://closeassist2.vercel.app/api/mcp
//
// Drafting tools need the CALLER's Anthropic key: set an `x-anthropic-key` header
// in the MCP client config. No key is ever stored — it's used per-request only.
// The calculators (net sheet, deadlines) are pure math and need no key.

export const config = { maxDuration: 60 };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ES_INSTRUCT = "\n\nWrite your entire response in Spanish (neutral Latin American Spanish, warm and professional, appropriate for US Hispanic real estate clients). Keep proper names, addresses, and numbers as-is.";

function langInstruct(lang) {
  return lang === "es" ? ES_INSTRUCT : "";
}

async function draft(key, system, user) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1600,
      system: system || undefined,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ("Anthropic request failed (" + res.status + ")"));
  return (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n").trim();
}

// ---------- calculators (ported from the app) ----------

function num(v) {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
}
function money(n) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function netSheet(a) {
  const price = num(a.sale_price);
  if (!price) throw new Error("sale_price is required.");
  const stateStamp = a.transfer_state != null ? num(a.transfer_state) : Math.ceil(price / 500) * 0.5;
  const countyStamp = a.transfer_county != null ? num(a.transfer_county) : Math.ceil(price / 500) * 0.25;
  const cityStamp = num(a.transfer_city);
  const commission = a.commission_flat != null && String(a.commission_flat).trim() !== ""
    ? num(a.commission_flat)
    : price * num(a.commission_pct === undefined ? 6 : a.commission_pct) / 100;
  const taxProration = (a.annual_tax != null && a.tax_proration_months != null)
    ? num(a.annual_tax) / 12 * num(a.tax_proration_months) : 0;
  const lines = [
    ["Commission", commission],
    ["Attorney fee", num(a.attorney_fee === undefined ? 750 : a.attorney_fee)],
    ["Owner's title insurance", num(a.title)],
    ["State transfer stamp", stateStamp],
    ["County transfer stamp", countyStamp],
    ["City transfer stamp", cityStamp],
    ["Recording fees", num(a.recording)],
    ["Settlement / closing fee", num(a.settlement)],
    ["Survey", num(a.survey)],
    ["Tax proration", taxProration],
    ["Seller credit", num(a.seller_credit)],
    ["HOA", num(a.hoa)],
    ["Other liens", num(a.other_liens)],
    ["Misc", num(a.misc)],
  ];
  const totalCosts = lines.reduce((s, l) => s + l[1], 0);
  const loanPayoff = num(a.loan_payoff);
  const net = price - loanPayoff - totalCosts;
  let out = "SELLER NET SHEET (Illinois estimate)\n";
  out += "Sale price: " + money(price) + "\n\n";
  for (const [label, val] of lines) out += label + ": " + money(val) + "\n";
  out += "\nTotal closing costs: " + money(totalCosts) + "\n";
  out += "Loan payoff: " + money(loanPayoff) + "\n";
  out += "ESTIMATED NET TO SELLER: " + money(net) + "\n";
  out += "\nEstimate only — confirm all figures with the title company before presenting.";
  return out;
}

function addCalDays(base, days) {
  const d = new Date(base + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d;
}
function addBizDays(base, days) {
  const d = new Date(base + "T00:00:00");
  let added = 0;
  const step = days >= 0 ? 1 : -1;
  while (Math.abs(added) < Math.abs(days)) {
    d.setDate(d.getDate() + step);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += step;
  }
  return d;
}
function fmt(d) {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function deadlines(a) {
  const accept = a.acceptance_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accept || "")) throw new Error("acceptance_date is required (YYYY-MM-DD).");
  const list = [
    ["Attorney Review ends", addBizDays(accept, 5), "Multi-Board 8.0 Para 13 — 5 business days"],
    ["Inspection notice due", addBizDays(accept, 5), "Para 15 — typically 5 business days"],
    ["Homeowner insurance contingency", addBizDays(accept, 10), "Para 9 — 10 business days"],
    ["Financing approval (contingency date)", addCalDays(accept, 45), "Para 8 — 45 calendar days"],
  ];
  if (a.closing_date && /^\d{4}-\d{2}-\d{2}$/.test(a.closing_date)) {
    list.push(["Closing", new Date(a.closing_date + "T00:00:00"), "Para 5"]);
  }
  list.sort((x, y) => x[1] - y[1]);
  let out = "TRANSACTION DEADLINES" + (a.property_address ? " — " + a.property_address : "") + "\n";
  out += "Date of Acceptance: " + fmt(new Date(accept + "T00:00:00")) + "\n\n";
  for (const [label, date, note] of list) out += fmt(date) + " — " + label + " (" + note + ")\n";
  out += "\nEstimate from standard Multi-Board 8.0 timelines — verify against the executed contract and any riders.";
  return out;
}

// ---------- tool definitions ----------

const TOOLS = [
  {
    name: "draft_follow_up",
    description: "Write 3 natural, human, non-pushy follow-up messages for a real estate lead (text, email, or DM). Tuned for agents — moves the conversation forward and invites a reply.",
    needsKey: true,
    inputSchema: {
      type: "object",
      properties: {
        lead_name: { type: "string", description: "Lead's first name (optional)" },
        situation: { type: "string", description: "What's going on with this lead — context, history, concerns" },
        channel: { type: "string", enum: ["Text", "Email", "DM"], default: "Text" },
        tone: { type: "string", enum: ["Warm", "Direct", "Playful", "Professional"], default: "Warm" },
        language: { type: "string", enum: ["en", "es"], default: "en", description: "Draft language: English or Spanish" },
      },
      required: ["situation"],
    },
    run: async (p, key) => {
      const channel = p.channel || "Text";
      const tone = p.tone || "Warm";
      const system = "You are an elite real estate sales coach writing follow-up messages for an agent. Natural, human, non-pushy messages that move things forward and invite a reply. Keep " + channel.toLowerCase() + "s brief. Tone: " + tone + ". Return exactly 3 distinct messages separated by a line containing only ===. No preamble or labels." + langInstruct(p.language);
      const user = "Lead name: " + (p.lead_name || "(unknown)") + "\nChannel: " + channel + "\nSituation:\n" + p.situation;
      return draft(key, system, user);
    },
  },
  {
    name: "handle_objection",
    description: "Get 3 confident, sayable responses to a client objection (empathize & reframe, clarifying question, address head-on). Never slimy.",
    needsKey: true,
    inputSchema: {
      type: "object",
      properties: {
        objection: { type: "string", description: "The objection the client raised" },
        language: { type: "string", enum: ["en", "es"], default: "en" },
      },
      required: ["objection"],
    },
    run: async (p, key) => {
      const system = "You are a master real estate sales coach. The agent pastes a client objection. Give 3 genuinely different responses (empathize & reframe / ask a clarifying question / address head-on with value). Each sayable almost verbatim, confident, never slimy. Start each with a 2-4 word strategy label in brackets. Separate the 3 with a line containing only ===." + langInstruct(p.language);
      return draft(key, system, "Objection: " + p.objection);
    },
  },
  {
    name: "draft_listing_description",
    description: "Write 3 compelling MLS-style listing descriptions from property notes. Leads with the strongest selling point, paints a lifestyle, never invents features, avoids fair-housing-risky language.",
    needsKey: true,
    inputSchema: {
      type: "object",
      properties: {
        property_details: { type: "string", description: "Property notes: beds, baths, sqft, features, neighborhood" },
        style: { type: "string", description: "Writing style, e.g. 'luxury', 'cozy starter home', 'modern'", default: "Standard" },
        length: { type: "string", enum: ["Short", "Standard", "Detailed"], default: "Standard", description: "Short ~50 words, Standard ~100, Detailed ~160" },
        language: { type: "string", enum: ["en", "es"], default: "en" },
      },
      required: ["property_details"],
    },
    run: async (p, key) => {
      const style = p.style || "Standard";
      const length = p.length || "Standard";
      const system = "You are a top-producing real estate copywriter. Write compelling MLS-style listing descriptions from the agent's notes. Lead with the strongest selling point, paint a lifestyle, stay truthful (never invent features), end with a light CTA. Style: " + style + ". Length: " + length + " (Short ~50 words, Standard ~100, Detailed ~160). Avoid fair-housing-risky language. Return 3 distinct versions separated by a line containing only ===." + langInstruct(p.language);
      return draft(key, system, "Property details:\n" + p.property_details);
    },
  },
  {
    name: "create_reel_hooks",
    description: "Write 10 scroll-stopping opening hooks (first lines) for a real-estate Reel/TikTok on any topic — varied styles: bold claim, question, mistake callout, number, contrarian, story tease.",
    needsKey: true,
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic for the hooks" },
        language: { type: "string", enum: ["en", "es"], default: "en" },
      },
      required: ["topic"],
    },
    run: async (p, key) => {
      const system = "You are a short-form video expert for real estate agents. Write 10 scroll-stopping opening HOOKS (first lines for a Reel/TikTok) on the topic — varied styles (bold claim, question, mistake callout, number, contrarian, story tease). One hook each, no numbering, separated by a line containing only ===." + langInstruct(p.language);
      return draft(key, system, "Topic: " + p.topic);
    },
  },
  {
    name: "seller_net_sheet",
    description: "Estimate an Illinois seller's closing costs and net proceeds. Uses IL transfer-tax formulas (state $0.50/$500, county $0.25/$500) with editable overrides. Pure math — no AI key needed.",
    needsKey: false,
    inputSchema: {
      type: "object",
      properties: {
        sale_price: { type: "number", description: "Expected sale price" },
        loan_payoff: { type: "number", description: "Mortgage payoff amount", default: 0 },
        commission_pct: { type: "number", description: "Commission percent (ignored if commission_flat set)", default: 6 },
        commission_flat: { type: "number", description: "Flat commission amount (overrides pct)" },
        annual_tax: { type: "number", description: "Annual property tax, for proration" },
        tax_proration_months: { type: "number", description: "Months of tax owed at closing" },
        attorney_fee: { type: "number", default: 750 },
        title: { type: "number", description: "Owner's title insurance" },
        transfer_state: { type: "number", description: "Override state stamp" },
        transfer_county: { type: "number", description: "Override county stamp" },
        transfer_city: { type: "number", description: "Municipal transfer tax" },
        recording: { type: "number" },
        settlement: { type: "number", description: "Title company settlement fee" },
        survey: { type: "number" },
        seller_credit: { type: "number" },
        hoa: { type: "number" },
        other_liens: { type: "number" },
        misc: { type: "number" },
      },
      required: ["sale_price"],
    },
    run: async (p) => netSheet(p),
  },
  {
    name: "contract_deadlines",
    description: "Map the key Illinois Multi-Board 8.0 contract deadlines from the date of acceptance (attorney review, inspection, insurance, financing). Pure math — no AI key needed.",
    needsKey: false,
    inputSchema: {
      type: "object",
      properties: {
        acceptance_date: { type: "string", description: "Date of acceptance, YYYY-MM-DD" },
        closing_date: { type: "string", description: "Closing date, YYYY-MM-DD (optional)" },
        property_address: { type: "string", description: "Property address (optional)" },
      },
      required: ["acceptance_date"],
    },
    run: async (p) => deadlines(p),
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------- JSON-RPC ----------

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

async function handleMessage(msg, headers) {
  const { id, method, params } = msg || {};
  if (!method) return err(id, -32600, "Invalid request.");
  if (method === "ping") return ok(id, {});
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "closeassist", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized") return null; // notification: no reply
  if (method === "tools/list") {
    return ok(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOL_MAP[name];
    if (!tool) return err(id, -32602, "Unknown tool: " + name + ".");
    try {
      let key = null;
      if (tool.needsKey) {
        key = headers["x-anthropic-key"] || "";
        if (!key) {
          return err(id, -32602, "This tool needs your Anthropic API key. Add an 'x-anthropic-key' header in your MCP client config for this server.");
        }
      }
      const text = await tool.run(args, key);
      return ok(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return err(id, -32603, e.message || "Tool failed.");
    }
  }
  return err(id, -32601, "Method not found: " + method + ".");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-anthropic-key, mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    // Plain-GET info for humans curling the endpoint.
    return res.status(200).json({
      name: "closeassist",
      version: "1.0.0",
      transport: "mcp-streamable-http",
      tools: TOOLS.map((t) => t.name),
      note: "Connect with an MCP client. Drafting tools need an 'x-anthropic-key' header.",
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json(err(null, -32700, "Parse error.")); }

  const headers = {};
  for (const k of Object.keys(req.headers || {})) headers[k.toLowerCase()] = req.headers[k];

  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const m of messages) {
    const r = await handleMessage(m, headers);
    if (r) replies.push(r);
  }
  if (replies.length === 0) return res.status(202).end(); // notifications only
  res.setHeader("Content-Type", "application/json");
  return res.status(200).json(replies.length === 1 ? replies[0] : replies);
}
