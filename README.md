# WhatsApp Loan Bot

A WhatsApp chatbot for a loan business. It:

1. **Answers customer questions** (rates, requirements, how to apply, approval
   time, hours) using a business profile you control.
2. **Takes loan applications** — it notices when someone wants to apply and
   collects their **full name, phone number, loan amount, and reason**.
3. **Saves the lead** to a file you can view in your browser, and tells the
   customer a representative will follow up.

Claude (Anthropic) writes the replies. Twilio connects it to WhatsApp. Railway
keeps it online so your phone can talk to it.

---

## 1. How the pieces fit together

```
Your phone (WhatsApp)
        │
        ▼
     Twilio  ──►  sends each message to your bot's web address
        │
        ▼
   This app (on Railway)
        │  builds a prompt from config/business.json
        ▼
     Claude  ──►  writes a reply, and decides when to save a lead
        │
        ▼
   This app  ──►  saves the lead to data/leads.json
        │
        ▼
     Twilio  ──►  delivers the reply back to your phone
```

You view captured leads at `https://your-app.up.railway.app/leads?key=...`

---

## 2. What I built vs. what you need to do

**Already built (all the code):**

| File | What it does |
|---|---|
| `src/index.js` | The web server. Receives WhatsApp messages, sends replies, serves the leads page. |
| `src/anthropic.js` | Talks to Claude. Builds the system prompt from your business info. |
| `src/leadTool.js` | Defines the "save this lead" action Claude can trigger. |
| `src/businessHours.js` | Works out if you're open right now (Jamaica time). |
| `src/store.js` | Saves conversations and leads to JSON files. |
| `src/config.js` | Loads your keys and settings. |
| `config/business.json` | **Your business details.** Edit this file to change what the bot says. |

**What you need to do (about 20–30 minutes):**

1. Get a Claude API key — *Section 3*
2. Create a Twilio account and turn on the WhatsApp Sandbox — *Section 4*
3. Deploy this folder to Railway — *Section 5*
4. Paste your Railway address into Twilio — *Section 6*
5. Message the bot from your phone — *Section 7*

You will copy **4 secret values** along the way. Keep them somewhere safe:

- `ANTHROPIC_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (the sandbox number)

---

## 3. Get your Claude API key

1. Go to **https://console.anthropic.com** and sign in (or create an account).
2. Add a payment method / some credit: **Settings → Billing**. A few dollars is
   plenty for testing (see *Section 9* for costs).
3. Go to **Settings → API Keys → Create Key**. Name it "whatsapp-bot".
4. **Copy the key now** (starts with `sk-ant-`). You can't see it again later.

That's your `ANTHROPIC_API_KEY`.

---

## 4. Create Twilio + turn on the WhatsApp Sandbox

Twilio's **Sandbox** lets you test a WhatsApp bot for free with your own phone,
with no Facebook/Meta business approval. Perfect for this practice build.

1. Sign up at **https://www.twilio.com/try-twilio**. Verify your email and your
   phone number.
2. On the Twilio Console dashboard, find the **Account Info** panel. Copy:
   - **Account SID** (starts with `AC…`) → this is `TWILIO_ACCOUNT_SID`
   - **Auth Token** (click to reveal) → this is `TWILIO_AUTH_TOKEN`
3. In the left menu go to **Messaging → Try it out → Send a WhatsApp message**.
4. You'll see a sandbox number (usually **+1 415 523 8886**) and a **join code**
   like `join happy-tiger`.
   - The number, written as `whatsapp:+14155238886`, is your
     `TWILIO_WHATSAPP_FROM`.
5. **From WhatsApp on your phone**, send that exact join message (e.g.
   `join happy-tiger`) to the sandbox number. You should get a "connected" reply.
   Your phone is now linked to the sandbox.

Leave this Twilio tab open — you'll come back to it in *Section 6* to set the
webhook.

---

## 5. Deploy to Railway

Railway runs the app on the internet so Twilio can reach it. The easiest way
(no GitHub account needed) is Railway's command-line tool.

### 5a. Install the tools (one time)

You need **Node.js** (v18 or newer). Check by opening a terminal
(PowerShell on Windows) and running:

```bash
node --version
```

If it prints a version, you're set. If not, install it from
**https://nodejs.org** (the "LTS" download), then reopen the terminal.

Install the Railway CLI:

```bash
npm install -g @railway/cli
```

### 5b. Log in and create the project

In your terminal, go into this folder:

```bash
cd path/to/whatsapp-loan-bot
```

Then:

```bash
railway login
```

(That opens a browser to confirm.) Now create a project:

```bash
railway init
```

Give it a name like `whatsapp-loan-bot` when prompted.

### 5c. Add your secret values

Open the Railway dashboard: **https://railway.app/dashboard → your project →
your service → "Variables" tab**. Add these (click **New Variable** for each, or
use **Raw Editor** and paste the block):

```
ANTHROPIC_API_KEY=sk-ant-...your key...
TWILIO_ACCOUNT_SID=AC...your sid...
TWILIO_AUTH_TOKEN=...your token...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
DASHBOARD_KEY=some-long-random-string-you-make-up
```

> `DASHBOARD_KEY` is a password you invent. You'll need it to view leads.

Optional extras you can add later:

```
CLAUDE_MODEL=claude-haiku-4-5      # cheaper/faster than the default claude-opus-5
CLAUDE_EFFORT=low                  # low | medium — how hard Claude thinks
DATA_DIR=/data                     # only if you attach a Railway volume (see 5f)
```

### 5d. Deploy

From the folder, run:

```bash
railway up
```

Railway uploads the folder, installs dependencies, and starts it with
`npm start`. Wait for it to finish ("Build successful" / "Deployment live").

### 5e. Get your public address

In the Railway dashboard: **Settings → Networking → Generate Domain**.
You'll get something like:

```
https://whatsapp-loan-bot-production.up.railway.app
```

Open that URL in your browser. You should see:

```
QuiBot Loans WhatsApp bot is running.
```

If you see that, the app is live. 🎉

### 5f. (Optional) Keep leads across redeploys

Railway wipes files on every redeploy unless you attach a **Volume**.
In the dashboard: **your service → Volumes / "+ New" → Volume**, set the mount
path to `/data`, then add the variable `DATA_DIR=/data` and redeploy
(`railway up`). Now `data/leads.json` lives on the volume and survives updates.

---

## 6. Point Twilio at your bot

Back in the Twilio tab from *Section 4*:

1. Go to **Messaging → Try it out → Send a WhatsApp message → "Sandbox
   settings"** tab.
2. In **"When a message comes in"**, paste your Railway domain **plus
   `/whatsapp`**:

   ```
   https://whatsapp-loan-bot-production.up.railway.app/whatsapp
   ```

   Set the method to **HTTP POST**.
3. Click **Save**.

---

## 7. Test it from your phone

Open WhatsApp and message the sandbox number. Try:

- `What loans do you offer?`
- `What are your interest rates?`
- `Do I need collateral for $80,000?`
- `I want to apply for a loan`
  → the bot will ask for your name, phone, amount, and reason, one step at a
  time, then confirm a representative will follow up.

Send `reset` at any time to make the bot forget the conversation and start over.

**Watch it work:** in your terminal run `railway logs` to see each message,
Claude's reply, and a `🎯 NEW LEAD saved` line when an application completes.

---

## 8. Viewing captured leads

Open this in your browser (use the `DASHBOARD_KEY` you set):

```
https://whatsapp-loan-bot-production.up.railway.app/leads?key=your-dashboard-key
```

You'll get a table of every lead: time, name, phone, amount, reason, loan type,
and the WhatsApp number it came from. Add `&format=json` to download it as JSON.

The raw file is `data/leads.json` on the server.

---

## 9. What it costs

| Service | Cost for testing |
|---|---|
| Twilio WhatsApp **Sandbox** | Free |
| Anthropic (Claude) | Pay per message. With the default `claude-opus-5`, expect roughly **US$0.01–0.03 per customer message**. Switch to `CLAUDE_MODEL=claude-haiku-4-5` for about **1/5 of that**. |
| Railway | Free trial credit, then the Hobby plan (~US$5/month) to stay always-on. |

For a practice build, set `CLAUDE_MODEL=claude-haiku-4-5` and you'll spend cents.

---

## 10. Swapping in the real business info

Everything the bot knows lives in **`config/business.json`**. Edit that file —
loan types, amounts, rates, requirements, hours, FAQ, tone — then redeploy:

```bash
railway up
```

Nothing in `src/` needs to change. Keys to know:

- `businessHours` — per weekday `{ "open": "09:00", "close": "17:00" }`, or
  `null` for a closed day. `timezone` controls what "now" means.
- `afterHoursMessage` — guidance the bot follows when you're closed.
- `faq` — extra Q&A pairs the bot can draw on.
- `toneGuidelines` — how it should sound.
- `leadFieldsToCollect` — documented for you; the four fields the bot collects
  are defined in `src/leadTool.js` if you ever need to add one.

To run a second business, copy the file and deploy with
`BUSINESS_CONFIG=config/other-business.json`.

---

## 11. Running it on your own computer first (optional)

If you'd rather test locally before Railway:

1. Copy `.env.example` to `.env` and fill in the values.
2. `npm install`
3. `npm start` — it runs on `http://localhost:3000`.
4. Twilio still needs a public address, so in another terminal run a tunnel:
   `npx ngrok http 3000`, then use the `https://…ngrok…` URL + `/whatsapp` as
   the Twilio webhook.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Browser shows the "bot is running" page, but WhatsApp gets no reply | Twilio webhook URL is wrong or missing `/whatsapp`, or method isn't POST. Re-check *Section 6*. |
| "technical problem" reply every time | Bad or unfunded `ANTHROPIC_API_KEY`. Check **console.anthropic.com → Billing** and the Variables tab. |
| Nothing in `railway logs` when you message | Your phone isn't joined to the sandbox — resend the `join …` code (*Section 4, step 5*). |
| Replies work but no leads are saved | The customer didn't give all four details, or you redeployed and lost `data/` — attach a volume (*Section 5f*). |
| `403 invalid signature` in logs | You set `VALIDATE_TWILIO_SIGNATURE=true` without a correct `PUBLIC_URL`. Either remove that variable or set `PUBLIC_URL` to your exact Railway domain. |
| Bot invents a rate or promises approval | Tighten `toneGuidelines` in `config/business.json`; it's already told not to. |

---

## 13. Going beyond the sandbox (later)

The Twilio Sandbox only talks to phones that sent the `join` code, and messages
show a "Sandbox" prefix. To use a real WhatsApp business number you'll need to
register a Twilio WhatsApp Sender and go through Meta's business verification
(**Messaging → Senders → WhatsApp senders** in the Twilio Console). The code
doesn't change — you just update `TWILIO_WHATSAPP_FROM` to the approved number.

---

## Security notes

- `.env`, `node_modules/`, and `data/` are git-ignored — don't commit secrets.
- The bot is told never to accept full ID numbers, PINs, passwords, or card
  details over chat, and to warn customers who send them.
- Protect the `/leads` page with a long `DASHBOARD_KEY`.
- Turn on `VALIDATE_TWILIO_SIGNATURE=true` (with `PUBLIC_URL` set) before any
  real use, so only Twilio can post to your webhook.
