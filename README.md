# CloseAssist Backend — Offer Analyzer (Step 1)

This is the first piece of your standalone backend: **upload competing offer PDFs, get a ranked recommendation.** PDF text is read in the browser, so only text reaches your server — small, cheap, and private. (Scanned PDFs need OCR, which is a later add; they're flagged automatically.)

You don't need to know how to code to deploy this. Follow the checklist.

---

## What you'll need
- An **Anthropic API key** — make one at https://console.anthropic.com → *API Keys*, then add a little prepaid credit under *Billing* ($5–10 is plenty to start).
- A free **GitHub** account (to hold the code).
- A free **Vercel** account (to run it). Vercel reads from GitHub and deploys automatically.

---

## Deploy checklist

**1. Put the code on GitHub.**
- Create a new GitHub repo (e.g. `closeassist-backend`).
- Upload this whole folder to it (drag-and-drop works on github.com → *Add file* → *Upload files*).
- Do **not** upload a real `.env` file — only `.env.example` is here, which is safe.

**2. Import it into Vercel.**
- Go to https://vercel.com → *Add New* → *Project* → import your GitHub repo.
- Before clicking Deploy, open **Environment Variables** and add:
  - `ANTHROPIC_API_KEY` = your key from step above
  - `APP_SECRET` = any long random string you make up (you'll type this into the app)
- Click **Deploy**. Wait ~1 minute.

**3. Test it.**
- Vercel gives you a URL like `https://closeassist-backend.vercel.app`.
- Open it in your browser — you'll see the **Offer Analyzer** page.
- In *Backend URL*, paste your URL with `/api/analyze` on the end:
  `https://closeassist-backend.vercel.app/api/analyze`
- In *App key*, type the same `APP_SECRET` you set.
- Drop in 2+ offer PDFs and hit **Compare & recommend**.

That's it — you've got a working standalone tool that reads contracts.

---

## Costs (roughly)
- **Hosting:** $0 on Vercel's free tier at your volume.
- **AI usage:** you pay per use through your key. A 10-contract analysis runs roughly **$0.10–0.35**. Light monthly use is single digits. Watch your first Anthropic bill to calibrate.
- Switch `MODEL` to `claude-haiku-4-5-20251001` to cut cost further.

## Security notes
- `APP_SECRET` is what stops strangers from spending your API credit — keep it private, and rotate it if it leaks.
- Once you know your front-end's web address, set `ALLOWED_ORIGIN` to it so only your site can call the API.
- The server never stores the contracts — it reads the text, analyzes, and forgets.

## Limits (by design, for now)
- **Scanned/photographed PDFs** have no embedded text, so they can't be read yet (OCR is a future add). The page flags these.
- This is decision-support, **not legal or financial advice** — always verify terms against the signed documents.

---

## Wiring it into the main CloseAssist app (optional, later)
Inside CloseAssist's **Offer Compare** tool you can replace the paste boxes with a file upload that does the same browser-side extraction in `public/index.html`, then `fetch()` your `/api/analyze` URL with the `x-app-key` header. Ask me and I'll make that change when you're ready.

## Next pieces we can add to this backend
- OCR for scanned PDFs
- One-click DocuSign send
- Two-way Follow Up Boss sync
- Moving the other CloseAssist tools onto your key (full white-label)

Each is its own build — come back and I'll write the next one.
