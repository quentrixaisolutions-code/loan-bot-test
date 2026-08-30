// Express web service:
//   POST /whatsapp  -> Twilio calls this whenever your WhatsApp number gets a message
//   GET  /          -> health check ("bot is running")
//   GET  /leads     -> simple password-protected page listing captured leads
//
// Flow for an inbound message:
//   1. Twilio posts the message here.
//   2. We immediately answer Twilio with an empty response (so it doesn't time out).
//   3. In the background we ask Claude for a reply and send it back via Twilio's API.

import express from "express";
import twilio from "twilio";
import { config } from "./config.js";
import { generateReply } from "./anthropic.js";
import { getHistory, saveTurn, clearHistory, getLeads } from "./store.js";

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

// Remember recently handled message IDs so a Twilio retry can't double-process.
const seenMessageSids = new Set();

// ---- Health check -------------------------------------------------------
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `${config.business.businessName} WhatsApp bot is running.\n` +
      `Model: ${config.anthropic.model}\n` +
      `Business config: ${config.businessConfigPath}\n`,
  );
});

// ---- Twilio WhatsApp webhook -----------------------------------------
app.post("/whatsapp", (req, res) => {
  // Optional: verify the request really came from Twilio.
  if (config.twilio.validateSignature) {
    const signature = req.get("X-Twilio-Signature");
    const url = `${config.twilio.publicUrl}${req.originalUrl}`;
    const valid = twilio.validateRequest(
      config.twilio.authToken,
      signature,
      url,
      req.body,
    );
    if (!valid) {
      console.warn("Rejected webhook: bad Twilio signature. URL used:", url);
      return res.status(403).send("invalid signature");
    }
  }

  // Answer Twilio right away with an empty TwiML response.
  res.type("text/xml").send("<Response></Response>");

  // Then handle the message without blocking the HTTP response.
  handleInbound(req.body).catch((err) =>
    console.error("handleInbound crashed:", err),
  );
});

async function handleInbound(body) {
  const from = body.From; // e.g. "whatsapp:+18761234567"
  const text = (body.Body || "").trim();
  const messageSid = body.MessageSid;
  const profileName = body.ProfileName || null;

  if (!from || !text) return;

  if (messageSid) {
    if (seenMessageSids.has(messageSid)) return;
    seenMessageSids.add(messageSid);
    if (seenMessageSids.size > 500) {
      // keep the set from growing forever
      seenMessageSids.clear();
      seenMessageSids.add(messageSid);
    }
  }

  console.log(`\n<- ${from} (${profileName || "unknown"}): ${text}`);

  // Handy during testing: "reset" wipes this person's conversation memory.
  if (/^(reset|restart|clear)$/i.test(text)) {
    clearHistory(from);
    await sendWhatsApp(from, "Okay, I've cleared our chat history. How can I help?");
    return;
  }

  let reply;
  try {
    const history = getHistory(from);
    const result = await generateReply(history, text, {
      whatsappNumber: from,
      profileName,
    });
    reply = result.reply;
    saveTurn(from, text, reply);
  } catch (err) {
    console.error("generateReply failed:", err);
    reply =
      "Sorry - I'm having a technical problem right now. Please try again in a few minutes.";
  }

  await sendWhatsApp(from, reply);
}

async function sendWhatsApp(to, bodyText) {
  try {
    await twilioClient.messages.create({
      from: config.twilio.whatsappFrom,
      to,
      body: bodyText,
    });
    console.log(`-> ${to}: ${bodyText}`);
  } catch (err) {
    console.error("Failed to send WhatsApp message via Twilio:", err.message);
  }
}

// ---- Leads viewer ----------------------------------------------------
app.get("/leads", (req, res) => {
  if (req.query.key !== config.dashboardKey) {
    return res.status(401).type("text/plain").send("Unauthorized. Add ?key=YOUR_DASHBOARD_KEY");
  }

  const leads = getLeads().slice().reverse(); // newest first
  if (req.query.format === "json") {
    return res.json(leads);
  }

  const rows = leads
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.capturedAt)}</td>
        <td>${escapeHtml(l.fullName)}</td>
        <td>${escapeHtml(l.phoneNumber)}</td>
        <td>${escapeHtml(l.loanAmount)}</td>
        <td>${escapeHtml(l.reason)}</td>
        <td>${escapeHtml(l.loanType || "")}</td>
        <td>${escapeHtml(l.whatsappNumber || "")}</td>
      </tr>`,
    )
    .join("\n");

  res.type("text/html").send(`<!doctype html>
<meta charset="utf-8">
<title>Leads - ${escapeHtml(config.business.businessName)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
  h1 { font-size: 1.3rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  tr:nth-child(even) { background: #fafafa; }
  .count { color: #666; }
</style>
<h1>${escapeHtml(config.business.businessName)} - captured leads
  <span class="count">(${leads.length})</span></h1>
<p><a href="?key=${encodeURIComponent(config.dashboardKey)}&format=json">Download as JSON</a></p>
<table>
  <tr><th>Captured (UTC)</th><th>Name</th><th>Phone</th><th>Amount</th><th>Reason</th><th>Type</th><th>WhatsApp #</th></tr>
  ${rows || `<tr><td colspan="7">No leads yet.</td></tr>`}
</table>`);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

app.listen(config.port, () => {
  console.log(
    `\n${config.business.businessName} WhatsApp bot listening on port ${config.port}` +
      `\n  Webhook path:  POST /whatsapp` +
      `\n  Leads viewer:  GET  /leads?key=${config.dashboardKey}` +
      `\n  Model:         ${config.anthropic.model} (effort: ${config.anthropic.effort})` +
      `\n  Signature check: ${config.twilio.validateSignature ? "ON" : "OFF"}\n`,
  );
});
