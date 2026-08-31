// Tiny file-backed storage for campaigns. Good enough for testing and low
// volume - swap for a real database if you outgrow it. The rest of the code
// only touches the functions exported here.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const campaignsFile = path.join(config.dataDir, "campaigns.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(campaignsFile, "utf8"));
  } catch {
    return [];
  }
}

function writeAll(campaigns) {
  const tmp = `${campaignsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(campaigns, null, 2));
  fs.renameSync(tmp, campaignsFile); // atomic-ish replace
}

export function listCampaigns() {
  return readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getCampaign(id) {
  return readAll().find((c) => c.id === id) || null;
}

export function saveCampaign(campaign) {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === campaign.id);
  if (idx === -1) all.push(campaign);
  else all[idx] = campaign;
  writeAll(all);
  return campaign;
}

// Convenience: load a campaign, let the caller mutate it, persist it back.
// `mutator` may be async. Multiple variants of the same campaign can be
// generating concurrently in the background, so writes for a given campaign
// id are serialized here to avoid one update clobbering another.
const locks = new Map();

export function updateCampaign(id, mutator) {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous
    .catch(() => {}) // don't let one failed update jam the queue
    .then(async () => {
      const campaign = getCampaign(id);
      if (!campaign) throw new Error(`Campaign not found: ${id}`);
      await mutator(campaign);
      saveCampaign(campaign);
      return campaign;
    });
  locks.set(
    id,
    next.finally(() => {
      if (locks.get(id) === next) locks.delete(id);
    }),
  );
  return next;
}
