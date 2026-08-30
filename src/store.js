// Tiny file-backed storage. Good enough for testing and low volume.
//
//  - conversations.json : { "<phone>": [ {role, content}, ... ] }
//  - leads.json         : [ { id, capturedAt, ...leadFields }, ... ]
//
// For production you would swap this for a real database, but the rest of the
// code only touches the functions exported here.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const leadsFile = path.join(config.dataDir, "leads.json");
const conversationsFile = path.join(config.dataDir, "conversations.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic-ish replace
}

// ---- Conversation history -------------------------------------------------

export function getHistory(phone) {
  const all = readJson(conversationsFile, {});
  return all[phone] || [];
}

export function saveTurn(phone, userText, botText) {
  const all = readJson(conversationsFile, {});
  const history = all[phone] || [];
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: botText });
  // Keep only the most recent N messages.
  all[phone] = history.slice(-config.historyLimit);
  writeJson(conversationsFile, all);
}

export function clearHistory(phone) {
  const all = readJson(conversationsFile, {});
  delete all[phone];
  writeJson(conversationsFile, all);
}

// ---- Leads --------------------------------------------------------------

export function saveLead(lead) {
  const leads = readJson(leadsFile, []);
  const record = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    ...lead,
  };
  leads.push(record);
  writeJson(leadsFile, leads);
  return record;
}

export function getLeads() {
  return readJson(leadsFile, []);
}
