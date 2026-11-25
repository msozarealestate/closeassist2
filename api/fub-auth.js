// Follow Up Boss OAuth — step 1 (2026-11-25).
// The app POSTs here (with its app token) and gets back the FUB
// authorize URL; the browser then goes to FUB's own login + consent
// screen. No API key is ever typed by the agent.
//
// The OAuth `state` value is an HMAC-signed payload carrying the
// CloseAssist account (owner/guest) that started the flow, so the
// callback can bind the resulting FUB tokens to that account — a
// guest on the same browser can never ride the owner's connection.
//
// Requires env: APP_SECRET, FUB_OAUTH_CLIENT_ID.

import crypto from "crypto";
import { accountOf } from "../lib/auth.js";

export const config = { maxDuration: 10 };

const APP_CLIENT = "closeassist-web";

export function signState(secret, acct) {
  const payload = Buffer.from(JSON.stringify({
    n: crypto.randomBytes(16).toString("hex"),
    acct: acct === "guest" ? "guest" : "owner",
    exp: Date.now() + 15 * 60 * 1000,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return payload + "." + sig;
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-token, x-app-client");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  if (req.headers["x-app-client"] !== APP_CLIENT) {
    return res.status(403).json({ error: "This endpoint only accepts requests from the CloseAssist app." });
  }
  const secret = process.env.APP_SECRET;
  if (!secret) return res.status(500).json({ error: "Server missing APP_SECRET." });
  const clientId = process.env.FUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Follow Up Boss login isn't switched on yet — the server needs FUB_OAUTH_CLIENT_ID. The API-key option below still works." });
  }

  const acct = accountOf(secret, req.headers["x-app-token"]) || "owner";
  const state = signState(secret, acct);
  const redirectUri = "https://" + req.headers.host + "/api/fub-callback";
  const url = "https://app.followupboss.com/oauth/authorize"
    + "?response_type=auth_code"
    + "&client_id=" + encodeURIComponent(clientId)
    + "&redirect_uri=" + encodeURIComponent(redirectUri)
    + "&state=" + encodeURIComponent(state);
  return res.status(200).json({ url });
}
