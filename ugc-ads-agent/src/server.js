// Express app: serves the dashboard (public/) and a small JSON API it talks
// to. The dashboard itself is static/unauthenticated; every API call must
// carry the dashboard key in an `x-dashboard-key` header (the frontend asks
// for it once and remembers it in localStorage).

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { listCampaigns, getCampaign } from "./store.js";
import { createCampaign, regenerateVariant, approveVariant } from "./pipeline.js";
import { MODELS } from "./higgsfieldClient.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

function requireKey(req, res, next) {
  if (req.get("x-dashboard-key") !== config.dashboardKey) {
    return res.status(401).json({ error: "Bad or missing x-dashboard-key header." });
  }
  next();
}

app.get("/api/config", requireKey, (_req, res) => {
  res.json({
    model: config.anthropic.model,
    higgsfieldDryRun: config.higgsfield.dryRun,
    models: MODELS,
    defaultVariants: config.defaultVariants,
  });
});

app.get("/api/campaigns", requireKey, (_req, res) => {
  res.json(listCampaigns());
});

app.get("/api/campaigns/:id", requireKey, (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  res.json(campaign);
});

app.post("/api/campaigns", requireKey, async (req, res) => {
  try {
    const campaign = await createCampaign(req.body || {});
    res.status(201).json(campaign);
  } catch (err) {
    console.error("createCampaign failed:", err);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/campaigns/:id/variants/:variantId/regenerate", requireKey, async (req, res) => {
  try {
    const campaign = getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Not found" });
    await regenerateVariant(req.params.id, req.params.variantId, req.body?.prompt);
    res.json({ ok: true });
  } catch (err) {
    console.error("regenerateVariant failed:", err);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/campaigns/:id/variants/:variantId/approve", requireKey, async (req, res) => {
  try {
    const campaign = await approveVariant(req.params.id, req.params.variantId);
    res.json(campaign);
  } catch (err) {
    console.error("approveVariant failed:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(
    `\nUGC ads agent listening on port ${config.port}` +
      `\n  Dashboard:  http://localhost:${config.port}/` +
      `\n  Model:      ${config.anthropic.model} (effort: ${config.anthropic.effort})` +
      `\n  Higgsfield: ${config.higgsfield.dryRun ? "DRY RUN (no credentials set)" : "live"}\n`,
  );
});
