// Orchestrates the full loop for one ad variant:
//
//   Claude (concept) -> Higgsfield (generate) -> poll -> Claude (review)
//        -> approved, or -> needs_revision (with a revised prompt) -> repeat
//
// Campaign creation returns immediately with variants in "queued" state;
// generation/review happens in the background and the dashboard polls
// GET /api/campaigns/:id to watch progress.

import crypto from "node:crypto";
import { config } from "./config.js";
import { generateConcepts, reviewVariant } from "./claudeClient.js";
import {
  submitGeneration,
  getGenerationStatus,
  MODELS,
} from "./higgsfieldClient.js";
import { getCampaign, saveCampaign, updateCampaign } from "./store.js";

function normalizeBrief(input) {
  const brief = {
    productName: String(input.productName || "").trim(),
    description: String(input.description || "").trim(),
    audience: String(input.audience || "").trim(),
    keySellingPoints: String(input.keySellingPoints || "").trim(),
    tone: String(input.tone || "").trim(),
    cta: String(input.cta || "").trim(),
    aspectRatio: input.aspectRatio || "9:16",
    referenceImageUrl: String(input.referenceImageUrl || "").trim() || null,
  };
  if (!brief.productName || !brief.description || !brief.audience) {
    throw new Error("productName, description, and audience are required.");
  }
  return brief;
}

/**
 * Create a campaign: ask Claude for concepts, persist the campaign with
 * variants queued, then kick off generation for each variant in the
 * background (not awaited). Returns the saved campaign right away.
 */
export async function createCampaign(input) {
  const brief = normalizeBrief(input);
  const numVariants = Math.min(Math.max(Number(input.numVariants) || config.defaultVariants, 1), 6);

  const concepts = await generateConcepts(brief, numVariants);

  const campaign = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    brief,
    variants: concepts.map((c) => ({
      id: crypto.randomUUID(),
      ...c,
      status: "queued", // queued -> generating -> reviewing -> approved | needs_revision | failed
      requestId: null,
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      review: null,
      error: null,
      attempts: 0,
      history: [],
    })),
  };

  saveCampaign(campaign);

  for (const variant of campaign.variants) {
    runVariant(campaign.id, variant.id).catch((err) =>
      console.error(`Variant ${variant.id} pipeline crashed:`, err),
    );
  }

  return campaign;
}

/**
 * Drive one variant from "queued"/"needs_revision" through generation and
 * review. Safe to call again on the same variant (used by regenerate).
 */
export async function runVariant(campaignId, variantId) {
  await updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.status = "generating";
    v.error = null;
    v.attempts += 1;
  });

  let job;
  try {
    const campaign = getCampaign(campaignId);
    const variant = findVariant(campaign, variantId);
    const model = MODELS[variant.suggestedModel] ? variant.suggestedModel : "seedance-text";
    const imageUrl = variant.useReferenceImage ? campaign.brief.referenceImageUrl : null;

    job = await submitGeneration(model, {
      prompt: variant.higgsfieldPrompt,
      imageUrl,
      aspectRatio: campaign.brief.aspectRatio,
    });
  } catch (err) {
    await markFailed(campaignId, variantId, err);
    return;
  }

  await updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.requestId = job.requestId;
    v.statusUrl = job.statusUrl;
    v.cancelUrl = job.cancelUrl;
    v.dryRun = job.dryRun;
  });

  let statusResult;
  try {
    statusResult = await pollUntilDone(job);
  } catch (err) {
    await markFailed(campaignId, variantId, err);
    return;
  }

  await updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.mediaUrl = statusResult.mediaUrl;
    v.mediaType = statusResult.mediaType;
    v.thumbnailUrl = statusResult.thumbnailUrl;
    v.status = "reviewing";
  });

  try {
    const campaign = getCampaign(campaignId);
    const variant = findVariant(campaign, variantId);
    const review = await reviewVariant(campaign.brief, variant, statusResult);

    await updateCampaign(campaignId, (c) => {
      const v = findVariant(c, variantId);
      v.review = review;
      v.status = review.approved ? "approved" : "needs_revision";
    });
  } catch (err) {
    // Generation succeeded but review failed - surface the media anyway and
    // let a human approve/regenerate manually instead of losing the result.
    console.error(`Review failed for variant ${variantId}:`, err);
    await updateCampaign(campaignId, (c) => {
      const v = findVariant(c, variantId);
      v.status = "needs_revision";
      v.review = { approved: false, feedback: `Automated review failed: ${err.message}`, revisedPrompt: "" };
    });
  }
}

/**
 * Regenerate a variant, optionally with a new prompt (defaults to the
 * reviewer's suggested revision, or the existing prompt if neither is set).
 */
export async function regenerateVariant(campaignId, variantId, overridePrompt) {
  await updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.history.push({
      attempt: v.attempts,
      higgsfieldPrompt: v.higgsfieldPrompt,
      mediaUrl: v.mediaUrl,
      review: v.review,
    });
    if (overridePrompt && overridePrompt.trim()) {
      v.higgsfieldPrompt = overridePrompt.trim();
    } else if (v.review?.revisedPrompt) {
      v.higgsfieldPrompt = v.review.revisedPrompt;
    }
    v.status = "queued";
    v.review = null;
    v.mediaUrl = null;
    v.thumbnailUrl = null;
  });

  runVariant(campaignId, variantId).catch((err) =>
    console.error(`Variant ${variantId} regenerate crashed:`, err),
  );
}

export async function approveVariant(campaignId, variantId) {
  return updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.status = "approved";
  });
}

// ---- helpers --------------------------------------------------------------

function findVariant(campaign, variantId) {
  const v = campaign.variants.find((v) => v.id === variantId);
  if (!v) throw new Error(`Variant not found: ${variantId}`);
  return v;
}

async function markFailed(campaignId, variantId, err) {
  console.error(`Variant ${variantId} failed:`, err);
  await updateCampaign(campaignId, (campaign) => {
    const v = findVariant(campaign, variantId);
    v.status = "failed";
    v.error = err.message || String(err);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilDone(job) {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    const result = await getGenerationStatus(job);
    if (result.state === "completed") return result;
    if (result.state === "failed") {
      throw new Error(result.error || "Higgsfield reported the generation failed.");
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Timed out waiting for Higgsfield to finish generating.");
}
