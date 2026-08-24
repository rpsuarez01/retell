# Retell → Airtable Bridge

Replaces Make: a small server that receives Retell webhooks and writes directly
to Airtable via its API. Two endpoints, matching the two things Retell sends:

- `POST /webhook/retell/call` — post-call logging (transcript, summary, route type)
  into your **Calls** table. Fires on `call_analyzed`.
- `POST /webhook/retell/booking` — the live `create_booking` function target,
  writes a full booking into your **Bookings** table mid-call.

## 1. Get your Airtable credentials
- **API key**: Airtable account → Developer Hub → Personal Access Tokens → create
  one scoped to `data.records:write` and `data.records:read` on your base.
- **Base ID**: open your base → Help → API documentation → the ID starts with `app...`.

## 2. Fill in your .env
Copy `.env.example` to `.env` and fill in your real values. Never commit `.env`.

## 3. Run locally to test
```
npm install
npm start
```
Server runs on http://localhost:3000. Use a tunnel (e.g. `ngrok http 3000`) to get
a public URL you can paste into Retell while testing.

## 4. Deploy somewhere it stays running
Any of these work — pick whichever you're comfortable with:
- **Railway** (railway.app) — easiest: connect this folder as a repo, it detects
  Node automatically, add the same env vars in its dashboard, done.
- **Render** (render.com) — same idea, free tier available, slightly slower cold starts.
- **Vercel** — works, but needs the routes adapted to serverless functions
  (each endpoint as its own file under `/api`) rather than one long-running
  Express app — ask if you want that version instead.

Whichever you pick, you'll get a public HTTPS URL like
`https://your-app.up.railway.app`.

## 5. Wire it into Retell
- Agent settings → **Webhook URL** → `https://your-app.../webhook/retell/call`
- Custom Function `create_booking` → endpoint →
  `https://your-app.../webhook/retell/booking`

## 6. What's intentionally left simple
- No signature verification yet — Retell sends an `x-retell-signature` header
  you can validate before trusting the payload. Worth adding before this touches
  a real paying client; skip it for pilot testing.
- The "link booking back to its call row" step is stubbed out — Airtable needs a
  filtered lookup by Call ID to find the matching Calls record before patching
  it, which is a couple more lines; say the word and I'll fill that in once
  you're at the stage of wanting that link populated automatically.
