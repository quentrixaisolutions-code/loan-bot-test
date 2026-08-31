// Thin wrapper around the Higgsfield API (docs.higgsfield.ai).
//
// Auth: `Authorization: Key <KEY_ID>:<KEY_SECRET>` — server-side only, never
// exposed to a browser. Requests are async: you POST to a model endpoint and
// get back a request id (+ status/cancel URLs), then poll until it's done.
//
// If no Higgsfield credentials are configured, every function below runs in
// DRY-RUN mode: it fabricates a request id and, after a short simulated
// delay, a "completed" result with placeholder media. That lets the whole
// app (concepts -> generate -> review -> regenerate) be built and tested
// before you have Higgsfield access. Flip it off automatically the moment
// HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET are set.
//
// NOTE ON EXACT RESPONSE SHAPE: Higgsfield's model catalog is large and the
// success payload for each model isn't fully documented publicly at the time
// this was written. `extractMedia()` below reads the common field names
// (output/outputs/result, video_url/image_url/url, thumbnail) defensively.
// If you hit a model whose response doesn't match, check
// https://docs.higgsfield.ai/docs/api-reference and adjust `extractMedia()`
// — nothing else needs to change.

import crypto from "node:crypto";
import { config } from "./config.js";

// Whitelisted model routes. Keep this list small and deliberate rather than
// letting Claude (or a user) supply an arbitrary path.
export const MODELS = {
  "seedance-text": {
    path: "/bytedance/seedance/v1/lite/text-to-video",
    kind: "video",
    needsImage: false,
    label: "Seedance (text-to-video, fast/cheap)",
  },
  "seedance-image": {
    path: "/bytedance/seedance/v1/lite/image-to-video",
    kind: "video",
    needsImage: true,
    label: "Seedance (product photo -> video)",
  },
  "dop-turbo": {
    path: "/higgsfield-ai/dop/turbo",
    kind: "video",
    needsImage: true,
    label: "DOP turbo (motion applied to a product/reference image)",
  },
  "soul-standard": {
    path: "/higgsfield-ai/soul/standard",
    kind: "image",
    needsImage: false,
    label: "Soul (text-to-image, for static UGC-style ad creative)",
  },
};

function authHeader() {
  return `Key ${config.higgsfield.keyId}:${config.higgsfield.keySecret}`;
}

function buildRequestBody(modelKey, { prompt, imageUrl, aspectRatio, durationSeconds }) {
  const aspect = aspectRatio || "9:16";
  switch (modelKey) {
    case "seedance-text":
      return {
        prompt,
        duration: durationSeconds || 6,
        resolution: "720p",
        aspect_ratio: aspect,
      };
    case "seedance-image":
      return {
        prompt,
        image_url: imageUrl,
        duration: durationSeconds || 6,
        aspect_ratio: aspect,
      };
    case "dop-turbo":
      return {
        prompt,
        image_url: imageUrl,
        enhance_prompt: true,
      };
    case "soul-standard":
      return {
        prompt,
        num_images: 1,
        resolution: "2K",
        aspect_ratio: aspect,
      };
    default:
      throw new Error(`Unknown Higgsfield model: ${modelKey}`);
  }
}

/**
 * Kick off a generation. Returns { requestId, statusUrl, cancelUrl, dryRun }.
 */
export async function submitGeneration(modelKey, params) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unknown Higgsfield model: ${modelKey}`);
  if (model.needsImage && !params.imageUrl) {
    throw new Error(`Model "${modelKey}" needs a reference image but none was provided.`);
  }

  if (config.higgsfield.dryRun) {
    return {
      requestId: `dryrun-${crypto.randomUUID()}`,
      statusUrl: null,
      cancelUrl: null,
      dryRun: true,
      submittedAt: Date.now(),
    };
  }

  const body = buildRequestBody(modelKey, params);
  const res = await fetch(`${config.higgsfield.baseUrl}${model.path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Higgsfield submit failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  return {
    requestId: data.request_id || data.id,
    statusUrl: data.status_url || null,
    cancelUrl: data.cancel_url || null,
    dryRun: false,
    submittedAt: Date.now(),
  };
}

/**
 * Poll a generation's current state.
 * Returns { state: "processing"|"completed"|"failed", mediaUrl, mediaType, thumbnailUrl, raw }.
 */
export async function getGenerationStatus(job) {
  if (job.dryRun) {
    // Simulate ~8s of "processing" so the UI/polling loop gets exercised.
    const elapsed = Date.now() - job.submittedAt;
    if (elapsed < 8000) {
      return { state: "processing", raw: { dryRun: true } };
    }
    const seed = encodeURIComponent(job.requestId.slice(-6));
    const placeholderUrl = `https://placehold.co/720x1280/111827/ffffff?text=DRY-RUN%0A${seed}`;
    return {
      state: "completed",
      mediaUrl: placeholderUrl,
      mediaType: "image",
      thumbnailUrl: placeholderUrl,
      raw: { dryRun: true, note: "Placeholder media - no Higgsfield credentials configured." },
    };
  }

  const url = job.statusUrl || `${config.higgsfield.baseUrl}/requests/${job.requestId}/status`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Higgsfield status check failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return normalizeStatus(data);
}

export async function cancelGeneration(job) {
  if (job.dryRun || !job.requestId) return;
  const url = job.cancelUrl || `${config.higgsfield.baseUrl}/requests/${job.requestId}/cancel`;
  await fetch(url, { method: "POST", headers: { Authorization: authHeader() } }).catch((err) =>
    console.error("Higgsfield cancel failed:", err.message),
  );
}

// --- Response normalization ------------------------------------------------

const DONE_STATES = new Set(["completed", "succeeded", "success", "finished", "done"]);
const FAILED_STATES = new Set(["failed", "error", "cancelled", "canceled"]);

function normalizeStatus(data) {
  const rawState = String(data.status || data.state || "").toLowerCase();
  let state = "processing";
  if (DONE_STATES.has(rawState)) state = "completed";
  else if (FAILED_STATES.has(rawState)) state = "failed";

  const { mediaUrl, mediaType, thumbnailUrl } = extractMedia(data);
  if (state === "completed" && !mediaUrl) {
    // Got a "done" status but no media we recognize - treat as failed so the
    // pipeline surfaces it instead of silently hanging.
    state = "failed";
  }

  return {
    state,
    mediaUrl,
    mediaType,
    thumbnailUrl: thumbnailUrl || mediaUrl,
    error: data.error || data.error_message || null,
    raw: data,
  };
}

function extractMedia(data) {
  const candidates = [
    data.output,
    ...(Array.isArray(data.outputs) ? data.outputs : []),
    data.result,
    ...(Array.isArray(data.results) ? data.results : []),
    ...(Array.isArray(data.assets) ? data.assets : []),
    data,
  ].filter(Boolean);

  for (const c of candidates) {
    const videoUrl = c.video_url || c.video || (c.videos && c.videos[0]?.url);
    if (videoUrl) {
      return { mediaUrl: videoUrl, mediaType: "video", thumbnailUrl: c.thumbnail_url || c.cover_url };
    }
    const imageUrl = c.image_url || c.url || (c.images && c.images[0]?.url);
    if (imageUrl && typeof imageUrl === "string") {
      return { mediaUrl: imageUrl, mediaType: "image", thumbnailUrl: c.thumbnail_url };
    }
  }
  return { mediaUrl: null, mediaType: null, thumbnailUrl: null };
}
