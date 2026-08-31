// Loads and validates all configuration from environment variables.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`\nMissing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill it in (see README.md).\n");
    process.exit(1);
  }
  return value.trim();
}

const higgsfieldKeyId = (process.env.HIGGSFIELD_KEY_ID || "").trim();
const higgsfieldKeySecret = (process.env.HIGGSFIELD_KEY_SECRET || "").trim();

export const config = {
  port: Number(process.env.PORT) || 3000,

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    // Prefixed with UGC_ (rather than the more obvious CLAUDE_MODEL/
    // CLAUDE_EFFORT) because some hosts - including the one this was built
    // in - already set bare CLAUDE_EFFORT for unrelated tooling, which would
    // silently override this app's default.
    model: process.env.UGC_CLAUDE_MODEL || "claude-sonnet-5",
    effort: process.env.UGC_CLAUDE_EFFORT || "medium",
  },

  higgsfield: {
    keyId: higgsfieldKeyId,
    keySecret: higgsfieldKeySecret,
    // No credentials yet -> run the whole pipeline against a fake generator
    // so the app is fully testable before you sign up with Higgsfield.
    dryRun: !higgsfieldKeyId || !higgsfieldKeySecret,
    baseUrl: process.env.HIGGSFIELD_BASE_URL || "https://api.higgsfield.ai",
  },

  defaultVariants: Number(process.env.DEFAULT_VARIANTS) || 3,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 5000,
  pollTimeoutMs: Number(process.env.POLL_TIMEOUT_MS) || 10 * 60 * 1000,

  // Protects the dashboard + its API.
  dashboardKey: process.env.DASHBOARD_KEY || "changeme",

  dataDir: path.resolve(projectRoot, process.env.DATA_DIR || "data"),
};

fs.mkdirSync(config.dataDir, { recursive: true });
