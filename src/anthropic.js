// The "brain": builds the system prompt from the business config and asks
// Claude for a reply. Handles the small tool-use loop for saving leads.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { getBusinessStatus } from "./businessHours.js";
import { SAVE_LEAD_TOOL, handleSaveLead } from "./leadTool.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Turn the business config object into a readable briefing for Claude.
function businessBriefing(b) {
  const lines = [];
  lines.push(`Business name: ${b.businessName}`);
  if (b.tagline) lines.push(`Tagline: ${b.tagline}`);
  lines.push(`Loan types offered: ${b.loanTypes.join(", ")}`);
  lines.push(
    `Loan amount range: ${b.amountRange.note || `${b.amountRange.min}-${b.amountRange.max} ${b.currency}`}`,
  );
  lines.push(`Interest & fees: ${b.interestAndFees}`);
  lines.push(`Requirements:\n- ${b.requirements.join("\n- ")}`);
  lines.push(`Repayment terms: ${b.repaymentTerms}`);
  lines.push(`How to apply: ${b.howToApply}`);
  lines.push(`Approval time: ${b.approvalTime}`);
  if (Array.isArray(b.faq) && b.faq.length) {
    lines.push(
      "Common questions:\n" +
        b.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n"),
    );
  }
  return lines.join("\n");
}

function buildSystemPrompt(b) {
  const status = getBusinessStatus(b);

  const hoursNote = status.isOpen
    ? `The office is OPEN right now (local time: ${status.localTime}). A representative can follow up shortly.`
    : `The office is CLOSED right now (local time: ${status.localTime}). ` +
      `If the customer wants a person, tell them the team will reply ` +
      `${status.nextOpenLabel ? status.nextOpenLabel.replace(/^today at/, "later today at") : "on the next business day"}. ` +
      `You can still answer questions and collect application details now.`;

  return `You are the WhatsApp assistant for ${b.businessName}, a loan company.
You chat with customers over WhatsApp. Keep every reply short and easy to read
on a phone (usually 2-5 sentences). ${b.toneGuidelines || ""}

== BUSINESS INFORMATION (your only source of truth) ==
${businessBriefing(b)}

== CURRENT STATUS ==
${hoursNote}

== WHAT YOU DO ==
1. Answer questions about the loans using ONLY the business information above.
   If you don't know something, say a representative will confirm - never make
   up rates, terms, or approvals.
2. If the customer wants to APPLY for a loan, collect these four things, one or
   two at a time (don't interrogate):
     - full name
     - phone number
     - loan amount needed
     - reason for the loan
3. Once you have all four, call the save_lead tool exactly once. After it
   succeeds, confirm to the customer in your own words that their details were
   passed to the loan team and a representative will follow up
   ${status.isOpen ? "shortly" : `${status.nextOpenLabel || "on the next business day"}`}.
4. Never ask for full ID numbers, passwords, PINs, card numbers, or online
   banking details over chat. If a customer sends sensitive info like that,
   gently tell them not to share it here.

== STYLE ==
- Plain language, friendly, professional. No long paragraphs.
- Don't promise approval or a specific interest rate.
- Currency is ${b.currency}.`;
}

// Convert stored history (array of {role, content}) into the API's message
// format. Stored content is always a plain string, which is valid.
function toApiMessages(history, currentUserText) {
  return [...history, { role: "user", content: currentUserText }];
}

/**
 * Generate a reply.
 * @param {Array<{role:string,content:string}>} history  prior turns
 * @param {string} userText  the new inbound message
 * @param {object} context   { whatsappNumber, profileName }
 * @returns {Promise<{ reply: string, leadSaved: boolean }>}
 */
export async function generateReply(history, userText, context = {}) {
  const system = buildSystemPrompt(config.business);
  let messages = toApiMessages(history, userText);
  let leadSaved = false;

  // Small tool loop: at most a couple of iterations (reply -> maybe save_lead
  // -> final confirmation).
  for (let step = 0; step < 4; step++) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      output_config: { effort: config.anthropic.effort },
      system,
      tools: [SAVE_LEAD_TOOL],
      // Once the lead is saved in this turn, stop offering the tool so Claude
      // just writes the confirmation instead of saving a duplicate.
      tool_choice: leadSaved ? { type: "none" } : { type: "auto" },
      messages,
    });

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "save_lead") {
          let result;
          try {
            result = handleSaveLead(block.input, context);
            leadSaved = true;
          } catch (err) {
            console.error("save_lead failed:", err);
            result = { status: "error", message: "could not save" };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({ status: "unknown_tool" }),
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue; // ask Claude for the follow-up message
    }

    // Normal end of turn - pull the text out.
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      reply: text || "Sorry, I didn't quite catch that. Could you say it another way?",
      leadSaved,
    };
  }

  return {
    reply:
      "Thanks! Your details have been passed to our loan team and a representative will follow up.",
    leadSaved,
  };
}
