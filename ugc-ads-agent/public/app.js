// Tiny vanilla-JS dashboard - no build step. Talks to the JSON API in
// src/server.js, polling while any variant is still in flight.

const KEY_STORAGE = "ugc_dashboard_key";
let selectedCampaignId = null;
let pollTimer = null;

function getKey() {
  let key = localStorage.getItem(KEY_STORAGE);
  if (!key) {
    key = prompt("Enter the DASHBOARD_KEY from your .env file:") || "";
    if (key) localStorage.setItem(KEY_STORAGE, key);
  }
  return key;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-dashboard-key": getKey(),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    throw new Error("Bad dashboard key - reload the page and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const IN_FLIGHT = new Set(["queued", "generating", "reviewing"]);

async function loadConfig() {
  const cfg = await api("/api/config");
  const banner = document.getElementById("statusBanner");
  if (cfg.higgsfieldDryRun) {
    banner.hidden = false;
    banner.textContent =
      "DRY RUN - no Higgsfield credentials configured. Generations use placeholder media.";
  } else {
    banner.hidden = true;
  }
}

async function loadCampaigns() {
  const campaigns = await api("/api/campaigns");
  const list = document.getElementById("campaignList");
  list.innerHTML = "";
  for (const c of campaigns) {
    const li = document.createElement("li");
    li.className = c.id === selectedCampaignId ? "active" : "";
    const doneCount = c.variants.filter((v) => !IN_FLIGHT.has(v.status)).length;
    li.innerHTML = `<span class="cname">${escapeHtml(c.brief.productName)}</span>
      <span class="cmeta">${new Date(c.createdAt).toLocaleString()} · ${doneCount}/${c.variants.length} done</span>`;
    li.addEventListener("click", () => selectCampaign(c.id));
    list.appendChild(li);
  }
  return campaigns;
}

async function selectCampaign(id) {
  selectedCampaignId = id;
  await renderDetail();
  loadCampaigns(); // refresh highlight
}

async function renderDetail() {
  if (!selectedCampaignId) return;
  const campaign = await api(`/api/campaigns/${selectedCampaignId}`);
  const detail = document.getElementById("detail");
  detail.hidden = false;
  document.getElementById("detailTitle").textContent = campaign.brief.productName;

  const grid = document.getElementById("variantGrid");
  grid.innerHTML = "";
  for (const v of campaign.variants) {
    grid.appendChild(renderVariantCard(campaign.id, v));
  }
}

function renderVariantCard(campaignId, v) {
  const card = document.createElement("div");
  card.className = "card";

  let mediaHtml = `<div class="media" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:.8rem;">${
    v.status === "failed" ? "Failed" : "Generating…"
  }</div>`;
  if (v.mediaUrl) {
    mediaHtml =
      v.mediaType === "video"
        ? `<video class="media" src="${escapeAttr(v.mediaUrl)}" controls></video>`
        : `<img class="media" src="${escapeAttr(v.mediaUrl)}" alt="${escapeAttr(v.angle)}" />`;
  }

  const scriptHtml = (v.script || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");

  const feedbackHtml = v.review
    ? `<div class="feedback"><strong>${v.review.approved ? "Approved" : "Needs revision"}:</strong> ${escapeHtml(v.review.feedback)}</div>`
    : v.error
      ? `<div class="feedback" style="color:var(--bad)">${escapeHtml(v.error)}</div>`
      : "";

  const canRegenerate = ["approved", "needs_revision", "failed"].includes(v.status);
  const canApprove = v.status === "needs_revision" && v.mediaUrl;

  card.innerHTML = `
    ${mediaHtml}
    <span class="badge ${v.status}">${v.status.replace("_", " ")}</span>
    <div class="angle">${escapeHtml(v.angle)}</div>
    <div class="hook">"${escapeHtml(v.hook)}"</div>
    <details>
      <summary>Script &amp; direction</summary>
      <ol>${scriptHtml}</ol>
      <p><strong>Visual:</strong> ${escapeHtml(v.visualDirection || "")}</p>
      <p><strong>Higgsfield prompt:</strong> ${escapeHtml(v.higgsfieldPrompt || "")}</p>
    </details>
    ${feedbackHtml}
    <div class="actions"></div>
  `;

  const actions = card.querySelector(".actions");

  if (canApprove) {
    const approveBtn = document.createElement("button");
    approveBtn.textContent = "Approve anyway";
    approveBtn.className = "secondary";
    approveBtn.onclick = async () => {
      await api(`/api/campaigns/${campaignId}/variants/${v.id}/approve`, { method: "POST" });
      renderDetail();
    };
    actions.appendChild(approveBtn);
  }

  if (canRegenerate) {
    const regenBtn = document.createElement("button");
    regenBtn.textContent = v.review?.revisedPrompt ? "Regenerate with revision" : "Regenerate";
    regenBtn.onclick = async () => {
      regenBtn.disabled = true;
      try {
        await api(`/api/campaigns/${campaignId}/variants/${v.id}/regenerate`, {
          method: "POST",
          body: JSON.stringify({ prompt: v.review?.revisedPrompt || "" }),
        });
        renderDetail();
        startPollingIfNeeded();
      } finally {
        regenBtn.disabled = false;
      }
    };
    actions.appendChild(regenBtn);
  }

  return card;
}

function startPollingIfNeeded() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const campaigns = await loadCampaigns().catch(() => []);
    if (selectedCampaignId) await renderDetail().catch(() => {});
    const anyInFlight = campaigns.some((c) => c.variants.some((v) => IN_FLIGHT.has(v.status)));
    if (!anyInFlight) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 4000);
}

document.getElementById("briefForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  errEl.hidden = true;
  const form = e.target;
  const fd = new FormData(form);
  const brief = Object.fromEntries(fd.entries());
  brief.numVariants = Number(brief.numVariants) || 3;

  const submitBtn = form.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Generating concepts…";
  try {
    const campaign = await api("/api/campaigns", { method: "POST", body: JSON.stringify(brief) });
    await loadCampaigns();
    await selectCampaign(campaign.id);
    startPollingIfNeeded();
    form.reset();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Generate concepts & ads";
  }
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function escapeAttr(value) {
  return escapeHtml(value);
}

(async function init() {
  try {
    await loadConfig();
    const campaigns = await loadCampaigns();
    if (campaigns.some((c) => c.variants.some((v) => IN_FLIGHT.has(v.status)))) {
      startPollingIfNeeded();
    }
  } catch (err) {
    document.getElementById("statusBanner").hidden = false;
    document.getElementById("statusBanner").textContent = err.message;
  }
})();
