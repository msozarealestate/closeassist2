// Follow Up Boss OAuth — step 2 (2026-11-25).
// FUB redirects the browser here after the agent logs in and approves
// (or denies) on FUB's own site: ?response=approved|denied&code&state.
// We verify the signed state, trade the one-time code for tokens at
// FUB's token endpoint (HTTP Basic client auth, form-encoded body,
// per FUB's OAuth docs), and store the tokens in HttpOnly cookies:
//   ca_fub_at    access token (60-minute life)
//   ca_fub_rt    refresh token (lifetime unless unused 90 days)
//   ca_fub_acct  the CloseAssist account the tokens are bound to
// The browser is then sent back into the app with ?fub=<result>; the
// tokens themselves never touch the page or localStorage.
//
// Requires env: APP_SECRET, FUB_OAUTH_CLIENT_ID, FUB_OAUTH_CLIENT_SECRET.

import crypto from "crypto";

export const config = { maxDuration: 15 };

function verifyState(secret, state) {
  if (!secret || !state || typeof state !== "string" || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

function cookie(name, value, maxAge) {
  return name + "=" + encodeURIComponent(value)
    + "; Path=/; Max-Age=" + maxAge
    + "; HttpOnly; Secure; SameSite=Lax";
}

export default async function handler(req, res) {
  const back = (q) => {
    res.setHeader("Location", "/app.html?" + q);
    return res.status(302).end();
  };
  try {
    const q = req.query || {};
    if (q.response === "denied") return back("fub=denied");
    const st = verifyState(process.env.APP_SECRET, q.state);
    if (!st || !q.code) return back("fub=error");
    const clientId = process.env.FUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.FUB_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return back("fub=error");

    const redirectUri = "https://" + req.headers.host + "/api/fub-callback";
    const basic = Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const r = await fetch("https://app.followupboss.com/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + basic,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(q.code),
        redirect_uri: redirectUri,
        state: String(q.state),
      }).toString(),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.access_token || !data.refresh_token) return back("fub=error");

    res.setHeader("Set-Cookie", [
      cookie("ca_fub_at", data.access_token, Number(data.expires_in) || 3600),
      cookie("ca_fub_rt", data.refresh_token, 90 * 24 * 3600),
      cookie("ca_fub_acct", st.acct === "guest" ? "guest" : "owner", 90 * 24 * 3600),
    ]);
    return back("fub=connected");
  } catch {
    return back("fub=error");
  }
}
