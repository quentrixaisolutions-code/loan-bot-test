// Defines the `save_lead` tool that Claude calls once it has gathered every
// piece of application info from the customer, plus the function that actually
// stores the lead.

import { saveLead } from "./store.js";

export const SAVE_LEAD_TOOL = {
  name: "save_lead",
  description:
    "Save a loan-application lead. Call this ONCE, only after the customer has " +
    "clearly said they want to apply AND has given all four of: full name, " +
    "phone number, loan amount needed, and the reason for the loan. Do not " +
    "guess or invent values - if something is missing, ask the customer for it " +
    "instead of calling this tool.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      fullName: {
        type: "string",
        description: "The customer's full name, exactly as they gave it.",
      },
      phoneNumber: {
        type: "string",
        description:
          "The best phone number to reach the customer, as they provided it.",
      },
      loanAmount: {
        type: "string",
        description:
          "The loan amount the customer is asking for, including currency if " +
          "stated, e.g. 'JMD 150,000'.",
      },
      reason: {
        type: "string",
        description: "The customer's stated reason / purpose for the loan.",
      },
      loanType: {
        type: "string",
        description:
          "Which product this looks like, if clear from the chat: personal, " +
          "payday, or business. Use 'unspecified' if unclear.",
      },
    },
    required: ["fullName", "phoneNumber", "loanAmount", "reason", "loanType"],
    additionalProperties: false,
  },
};

// Called by anthropic.js when Claude emits a save_lead tool_use block.
// `context` carries extra data we know from the channel (the WhatsApp number,
// the display name Twilio sends, etc.).
export function handleSaveLead(input, context = {}) {
  const record = saveLead({
    ...input,
    whatsappNumber: context.whatsappNumber || null,
    whatsappProfileName: context.profileName || null,
    source: "whatsapp",
  });

  console.log(
    `\n🎯 NEW LEAD saved (${record.id})\n` +
      `   Name:   ${record.fullName}\n` +
      `   Phone:  ${record.phoneNumber}\n` +
      `   Amount: ${record.loanAmount}\n` +
      `   Reason: ${record.reason}\n` +
      `   Type:   ${record.loanType}\n` +
      `   From:   ${record.whatsappNumber}\n`,
  );

  return { status: "saved", leadId: record.id };
}
