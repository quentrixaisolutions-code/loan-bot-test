# UGC Ads Agent (Claude + Higgsfield)

A small web app that turns a product brief into several UGC-style ad videos:

1. **Claude writes the creative** — for each brief it proposes distinct ad
   angles (hook, spoken script, visual direction, and a generation prompt).
2. **Higgsfield renders it** — each concept's prompt is submitted to
   Higgsfield's video/image API.
3. **Claude reviews the result** — once a generation finishes, Claude looks
   at it against the brief and either approves it or writes a revised
   prompt explaining what to fix.
4. **You regenerate or approve** from the dashboard — one click reruns a
   variant with the revised prompt (or your own edit).

```
Your brief (dashboard form)
        │
        ▼
     Claude   ──►  proposes N distinct ad concepts + Higgsfield prompts
        │
        ▼
  Higgsfield  ──►  generates video/image for each concept
        │
        ▼
     Claude   ──►  reviews the result against the brief (vision, when available)
        │
        ▼
   approved ──────────────► shown in the dashboard, ready to use
        │
   needs revision ──► you click "Regenerate" ──► back to Higgsfield
```

**You don't need a Higgsfield account to try this.** Without
`HIGGSFIELD_KEY_ID`/`HIGGSFIELD_KEY_SECRET` set, the app runs in **dry-run
mode**: it fabricates a "generation" (placeholder image, few seconds of
simulated processing) so the full concept → generate → review → regenerate
loop works end-to-end. Add real Higgsfield credentials later and nothing
else changes.

---

## 1. What's here

| File | What it does |
|---|---|
| `src/server.js` | Express app: serves the dashboard and its JSON API. |
| `src/pipeline.js` | Orchestrates one variant through generate → poll → review → (re)generate. |
| `src/claudeClient.js` | Talks to Claude: concept generation + result review (both via tool-use). |
| `src/higgsfieldClient.js` | Talks to Higgsfield's API (or fakes it in dry-run mode). |
| `src/store.js` | Saves campaigns to a JSON file (`data/campaigns.json`). |
| `src/config.js` | Loads env vars. |
| `public/` | The dashboard (plain HTML/CSS/JS, no build step). |

---

## 2. Get your Claude API key

1. Go to **https://console.anthropic.com** and sign in (or create an account).
2. Add billing credit: **Settings → Billing**.
3. **Settings → API Keys → Create Key**.
4. Copy the key (starts with `sk-ant-`) — that's your `ANTHROPIC_API_KEY`.

---

## 3. Run it locally (dry-run mode, no Higgsfield needed)

```bash
cd ugc-ads-agent
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and DASHBOARD_KEY
npm install
npm start
```

Open **http://localhost:3000**. When prompted, paste the `DASHBOARD_KEY`
you set in `.env` — the page remembers it in your browser.

Fill in the brief form and submit. You'll see:

- Claude's proposed concepts appear as cards almost immediately.
- Each card shows "Generating…" while Higgsfield (or the dry-run fake) runs.
- A placeholder image and a status badge appear when it's "done".
- Since dry-run has no real image to critique, review defaults to
  approved/needs-revision based on prompt reasoning alone — good enough to
  exercise the whole regenerate loop before you connect real credentials.

Try clicking **Regenerate** on a card to see the revise → resubmit loop.

---

## 4. Connect a real Higgsfield account

1. Sign up at **https://higgsfield.ai**.
2. Generate a server-side API key pair from Higgsfield Cloud — see
   **https://docs.higgsfield.ai** for exactly where (this changes as their
   dashboard evolves; look for "API keys" or "Developers"). You'll get two
   values: a **key ID** and a **key secret**.
3. Add both to `.env`:
   ```
   HIGGSFIELD_KEY_ID=...
   HIGGSFIELD_KEY_SECRET=...
   ```
4. Restart the app (`npm start`). The dashboard's dry-run banner disappears
   and generations now actually render on Higgsfield.

**Note on models:** this app only calls a small, whitelisted set of
Higgsfield models (`src/higgsfieldClient.js` → `MODELS`) — mostly Bytedance
Seedance (text/image-to-video) and Higgsfield DOP/Soul. Higgsfield has 30+
models; add more routes there if you want Claude to be able to pick them.

**Note on response shape:** Higgsfield's exact success-response fields
weren't fully documented at the time this was built, so
`extractMedia()` in `higgsfieldClient.js` reads a few common field-name
patterns defensively (`video_url`, `image_url`, `output`, etc.). If a real
generation completes but the dashboard doesn't pick up the media, check
`docs.higgsfield.ai/docs/api-reference`, print the raw response
(`console.log` in `getGenerationStatus`), and adjust `extractMedia()` — it's
the only place that needs to change.

---

## 5. How Claude decides what to generate

`src/claudeClient.js` forces a tool call (`propose_concepts`) so every
concept comes back as structured data — no prompt parsing. Each concept
includes:

- `angle` / `hook` / `script` / `visualDirection` / `onScreenText` — the
  creative, for a human to read.
- `higgsfieldPrompt` — the actual prompt sent to Higgsfield.
- `suggestedModel` — one of the whitelisted keys in `MODELS`.
- `useReferenceImage` — whether to generate from the brief's reference/
  product image (only when one is provided).

The review step (`reviewVariant`) also uses forced tool-use
(`submit_review`) and, when a real (non-dry-run) result thumbnail is
available, sends it to Claude as an image so the review is genuinely
visual, not just prompt-matching.

---

## 6. Deploying

This is a plain Node/Express app — deploy it anywhere that runs Node 18+
(Railway, Fly.io, Render, a VM, etc.):

```bash
npm install
npm start
```

Set the same env vars from `.env.example` as platform variables. If your
host wipes the filesystem on redeploy, point `DATA_DIR` at a persistent
volume so `data/campaigns.json` survives.

---

## 7. Security notes

- `.env` and `data/` are git-ignored — don't commit secrets or generated
  campaign data.
- The dashboard's API is gated behind `DASHBOARD_KEY` (sent as an
  `x-dashboard-key` header) — pick a long, random value, especially once
  you're spending real Higgsfield credits per generation.
- Higgsfield credentials are used **server-side only** (`src/higgsfieldClient.js`)
  and are never sent to the browser.
