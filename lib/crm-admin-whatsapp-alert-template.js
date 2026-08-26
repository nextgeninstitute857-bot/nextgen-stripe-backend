export const NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME = "nextgen_admin_lead_alert";
export const NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE = "en_US";
export const NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_CATEGORY = "UTILITY";

export const NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_BODY = [
  "🚨 NextGen CRM — Action Required",
  "",
  "Alert: {{1}}",
  "Student: {{2}}",
  "Contact: {{3}}",
  "Country and exam: {{4}}",
  "Interested in: {{5}}",
  "Latest message: “{{6}}”",
  "Ayla already explained: {{7}}",
  "Meeting time: {{8}}",
  "",
  "➡️ Next action: {{9}}",
  "",
  "Open the CRM to view the complete conversation and continue without asking the student to repeat information.",
].join("\n");

export const NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_EXAMPLE = Object.freeze([
  "Student requested Google Meet guidance",
  "Dr Sara Khan",
  "+1 555 123 4567 · sara@example.com",
  "USMLE Step 1 · United States",
  "Live classes, recordings and QBank",
  "I am interested but need help choosing the right plan.",
  "Roadmap; live classes; recordings; adaptive flashcards; 7-day demo",
  "Wednesday, 5:00 PM EST",
  "Confirm the meeting and add the Google Meet link.",
]);

function cleanTemplateValue(value = "", fallback = "Not provided", maxLength = 700) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.slice(0, maxLength);
}

export function getNextGenAdminAlertMetaTemplateDefinition() {
  return {
    name: NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME,
    language: NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE,
    category: NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_CATEGORY,
    components: [
      {
        type: "BODY",
        text: NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_BODY,
        example: { body_text: [[...NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_EXAMPLE]] },
      },
    ],
  };
}

export function buildNextGenAdminAlertText(values = {}) {
  const payload = buildNextGenAdminAlertTemplatePayload(values);
  const replacements = payload.components[0].parameters.map((item) => item.text);
  return NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_BODY.replace(/{{(\d+)}}/g, (_match, index) => (
    replacements[Number(index) - 1] || "Not provided"
  ));
}

export function buildNextGenAdminAlertTemplatePayload({
  templateName = NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME,
  languageCode = NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE,
  alertLabel = "CRM lead update",
  studentName = "Student",
  contactLabel = "Not provided",
  examCountryLabel = "Not provided",
  interestsLabel = "Not provided",
  latestMessage = "No recent message was available.",
  coverageLabel = "Not provided",
  meetingTime = "Not scheduled",
  nextStep = "Open the CRM and continue from the saved conversation history.",
} = {}) {
  return {
    templateName: cleanTemplateValue(templateName, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME, 512),
    languageCode: cleanTemplateValue(languageCode, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE, 32),
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: cleanTemplateValue(alertLabel, "CRM lead update", 80) },
          { type: "text", text: cleanTemplateValue(studentName, "Student", 90) },
          { type: "text", text: cleanTemplateValue(contactLabel, "Not provided", 150) },
          { type: "text", text: cleanTemplateValue(examCountryLabel, "Not provided", 110) },
          { type: "text", text: cleanTemplateValue(interestsLabel, "Not provided", 130) },
          { type: "text", text: cleanTemplateValue(latestMessage, "No recent message was available.", 220) },
          { type: "text", text: cleanTemplateValue(coverageLabel, "Not provided", 180) },
          { type: "text", text: cleanTemplateValue(meetingTime, "Not scheduled", 100) },
          { type: "text", text: cleanTemplateValue(nextStep, "Open the CRM and continue from the saved conversation history.", 180) },
        ],
      },
    ],
  };
}
