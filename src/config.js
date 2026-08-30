// Loads and validates all configuration: environment variables + the swappable
// business profile in config/business.json.
//
// To use this bot for a DIFFERENT business, you only need to edit
// config/business.json - nothing in the src/ folder should need to change.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

// Which business profile to load. Override with BUSINESS_CONFIG=config/other.json
const businessConfigPath = path.resolve(
  projectRoot,
  process.env.BUSINESS_CONFIG || "config/business.json",
);

let business;
try {
  business = JSON.parse(fs.readFileSync(businessConfigPath, "utf8"));
} catch (err) {
  console.error(`\nCould not read business config at ${businessConfigPath}`);
  console.error(err.message);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`\nMissing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill it in (see README.md).\n");
    process.exit(1);
  }
  return value.trim();
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    // Default is the most capable model. For a high-volume FAQ bot you can
    // switch to a cheaper model by setting CLAUDE_MODEL=claude-haiku-4-5
    model: process.env.CLAUDE_MODEL || "claude-opus-5",
    // "low" keeps replies fast and inexpensive; raise to "medium" for more
    // careful answers.
    effort: process.env.CLAUDE_EFFORT || "low",
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS) || 1024,
  },

  twilio: {
    accountSid: required("TWILIO_ACCOUNT_SID"),
    authToken: required("TWILIO_AUTH_TOKEN"),
    // The Twilio Sandbox number, e.g. "whatsapp:+14155238886"
    whatsappFrom: required("TWILIO_WHATSAPP_FROM"),
    // Reject webhook calls that aren't signed by Twilio. Safe to leave off
    // while testing the Sandbox; turn on for anything real.
    validateSignature: process.env.VALIDATE_TWILIO_SIGNATURE === "true",
    // Public URL of this service, used only for signature validation, e.g.
    // https://your-app.up.railway.app  (no trailing slash, no path)
    publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  },

  // Simple key that protects the /leads viewing page.
  dashboardKey: process.env.DASHBOARD_KEY || "changeme",

  // Where leads.json and conversations.json are written. On Railway, point this
  // at a mounted volume (e.g. /data) so leads survive redeploys.
  dataDir: path.resolve(projectRoot, process.env.DATA_DIR || "data"),

  // How many past messages (user + bot) to remember per phone number.
  historyLimit: Number(process.env.HISTORY_LIMIT) || 20,

  business,
  businessConfigPath,
};

fs.mkdirSync(config.dataDir, { recursive: true });
