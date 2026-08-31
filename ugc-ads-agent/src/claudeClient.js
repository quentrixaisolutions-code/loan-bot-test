// Claude does two jobs in this pipeline:
//   1. Concept writer: turn a product brief into several distinct UGC-style
//      ad concepts (hook, script, visual direction, a Higgsfield prompt).
//   2. Reviewer: look at what Higgsfield actually produced (when it's an
//      image / video thumbnail) and either approve it or hand back a
//      revised prompt to try again.
// Both use forced tool-use so we get reliable structured output instead of
// parsing prose.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { MODELS } from "./higgsfieldClient.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const PROPOSE_CONCEPTS_TOOL = {
  name: "propose_concepts",
  description:
    "Propose a set of distinct UGC-style ad concepts for the given product brief.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            angle: {
              type: "string",
              description:
                "The creative angle in a few words, e.g. 'before/after testimonial', " +
                "'unboxing reaction', 'day-in-the-life problem/solution'.",
            },
            hook: {
              type: "string",
              description:
                "The first 1-2 spoken lines. Written to stop the scroll in the first " +
                "2 seconds - specific, not generic.",
            },
            script: {
              type: "array",
              items: { type: "string" },
              description:
                "The full spoken script as short, in-order lines/beats a real person " +
                "would say on camera. Casual, not ad-copy.",
            },
            visualDirection: {
              type: "string",
              description:
                "Shot-by-shot direction: what the person/product/camera is doing.",
            },
            onScreenText: {
              type: "string",
              description: "On-screen caption/text overlay, or empty string if none.",
            },
            higgsfieldPrompt: {
              type: "string",
              description:
                "A single dense visual-generation prompt for Higgsfield: subject, " +
                "setting, action, camera framing, lighting, mood. This is what actually " +
                "gets sent to the video/image model - not the spoken script.",
            },
            suggestedModel: {
              type: "string",
              enum: Object.keys(MODELS),
              description:
                Object.entries(MODELS)
                  .map(([k, v]) => `${k} = ${v.label}`)
                  .join("; "),
            },
            useReferenceImage: {
              type: "boolean",
              description:
                "true if this concept should be generated FROM the brief's reference/" +
                "product image (only valid with an image-capable suggestedModel).",
            },
          },
          required: [
            "angle",
            "hook",
            "script",
            "visualDirection",
            "onScreenText",
            "higgsfieldPrompt",
            "suggestedModel",
            "useReferenceImage",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["concepts"],
    additionalProperties: false,
  },
};

const SUBMIT_REVIEW_TOOL = {
  name: "submit_review",
  description: "Submit your review verdict for one generated ad variant.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      approved: {
        type: "boolean",
        description: "true if this is good enough to ship as-is.",
      },
      feedback: {
        type: "string",
        description: "1-3 sentences a human creative director would find useful.",
      },
      revisedPrompt: {
        type: "string",
        description:
          "Required (non-empty) when approved=false: an improved Higgsfield prompt " +
          "that fixes the problem. Empty string when approved=true.",
      },
    },
    required: ["approved", "feedback", "revisedPrompt"],
    additionalProperties: false,
  },
};

function briefBriefing(brief) {
  const lines = [
    `Product/brand: ${brief.productName}`,
    `Description: ${brief.description}`,
    `Target audience: ${brief.audience}`,
  ];
  if (brief.keySellingPoints) lines.push(`Key selling points: ${brief.keySellingPoints}`);
  if (brief.tone) lines.push(`Tone: ${brief.tone}`);
  if (brief.cta) lines.push(`Call to action: ${brief.cta}`);
  lines.push(`Aspect ratio: ${brief.aspectRatio || "9:16"}`);
  lines.push(
    brief.referenceImageUrl
      ? `A reference/product image is available at: ${brief.referenceImageUrl}`
      : "No reference image was provided - use text-to-video/image concepts only.",
  );
  return lines.join("\n");
}

/**
 * Ask Claude for `numVariants` distinct UGC ad concepts.
 */
export async function generateConcepts(brief, numVariants) {
  const system = `You are a senior UGC (user-generated-content style) performance ad
creative strategist. You write ads that feel like a real customer filmed
themselves, not corporate ad copy - authentic, specific, a little imperfect.

Given a product brief, propose exactly ${numVariants} DISTINCT ad concepts
(different angles/hooks - do not just reword the same idea). Each concept
must include a Higgsfield generation prompt that a text/image-to-video model
can act on directly.${
    brief.referenceImageUrl
      ? " Since a reference/product image is available, prefer concepts with useReferenceImage=true and an image-capable suggestedModel where it strengthens the ad."
      : " No reference image is available, so useReferenceImage must be false and suggestedModel must not require an image."
  }

Call propose_concepts exactly once with all ${numVariants} concepts.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    output_config: { effort: config.anthropic.effort },
    system,
    tools: [PROPOSE_CONCEPTS_TOOL],
    tool_choice: { type: "tool", name: "propose_concepts" },
    messages: [{ role: "user", content: briefBriefing(brief) }],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block) throw new Error("Claude did not return concepts (no tool_use block).");
  let { concepts } = block.input;
  // Defensive: `strict: true` should guarantee a real array, but tool-use
  // input has been observed coming back as a JSON string instead - parse it
  // rather than let a rare model hiccup crash campaign creation.
  if (typeof concepts === "string") {
    concepts = JSON.parse(concepts).concepts;
  }
  if (!Array.isArray(concepts)) throw new Error("Claude's propose_concepts response had no concepts array.");
  return concepts;
}

// Claude's vision input only accepts these four raster types - anything else
// (notably image/svg+xml, which some placeholder/thumbnail services serve by
// default) must be skipped rather than sent, or the API call 400s.
const VISION_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function fetchImageBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const mediaType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!VISION_MEDIA_TYPES.has(mediaType)) return null; // e.g. a video, or svg - skip vision
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 8 * 1024 * 1024) return null; // keep the review call cheap
    return { data: buf.toString("base64"), mediaType };
  } catch {
    return null;
  }
}

/**
 * Review a completed generation against the brief + concept. Uses vision
 * when a real (non-dry-run) thumbnail/image is available.
 */
export async function reviewVariant(brief, variant, statusResult) {
  const content = [
    {
      type: "text",
      text: `Brief:\n${briefBriefing(brief)}\n\nConcept angle: ${variant.angle}\nHook: ${variant.hook}\nHiggsfield prompt used: ${variant.higgsfieldPrompt}\n\n` +
        (statusResult.thumbnailUrl
          ? "The generated result is attached below (or was not viewable as an image - judge from the prompt/script alignment alone in that case)."
          : "No viewable image was returned - judge based on how well the Higgsfield prompt captures the concept and brief."),
    },
  ];

  let usedVision = false;
  if (statusResult.thumbnailUrl) {
    const image = await fetchImageBase64(statusResult.thumbnailUrl);
    if (image) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data },
      });
      usedVision = true;
    }
  }

  const system = `You are a UGC ad creative director reviewing one generated ad variant
against its brief and concept. Be strict but fair: approve only if it
plausibly matches the brief, looks like real UGC (not obviously broken/
distorted), and would work as a scroll-stopping ad. If you reject it, give a
concrete revisedPrompt fixing the specific problem (not a vague rewrite).
Call submit_review exactly once.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    output_config: { effort: config.anthropic.effort },
    system,
    tools: [SUBMIT_REVIEW_TOOL],
    tool_choice: { type: "tool", name: "submit_review" },
    messages: [{ role: "user", content }],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block) throw new Error("Claude did not return a review (no tool_use block).");
  return { ...block.input, usedVision };
}
