import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNextGenAdminAlertText,
  buildNextGenAdminAlertTemplatePayload,
  getNextGenAdminAlertMetaTemplateDefinition,
  NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_BODY,
  NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_CATEGORY,
  NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE,
  NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME,
} from "../lib/crm-admin-whatsapp-alert-template.js";

test("admin WhatsApp alert uses the dedicated approved-template contract", () => {
  const payload = buildNextGenAdminAlertTemplatePayload({
    alertLabel: "Student asked about pricing",
    studentName: "Dr Sara",
    contactLabel: "+16475550123 · sara@example.com",
    examCountryLabel: "USMLE Step 1 · United States",
    interestsLabel: "Complete programme",
    latestMessage: "I need help choosing the correct plan.",
    coverageLabel: "Roadmap; 7-day demo; live session",
    meetingTime: "Wednesday, 5:00 PM EST",
    nextStep: "Open the CRM and follow up.",
  });

  assert.equal(payload.templateName, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME);
  assert.equal(payload.languageCode, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE);
  assert.equal(payload.components.length, 1);
  assert.deepEqual(
    payload.components[0].parameters.map((parameter) => parameter.text),
    [
      "Student asked about pricing",
      "Dr Sara",
      "+16475550123 · sara@example.com",
      "USMLE Step 1 · United States",
      "Complete programme",
      "I need help choosing the correct plan.",
      "Roadmap; 7-day demo; live session",
      "Wednesday, 5:00 PM EST",
      "Open the CRM and follow up.",
    ],
  );
});

test("admin WhatsApp template values are compact and never empty", () => {
  const payload = buildNextGenAdminAlertTemplatePayload({ latestMessage: "x".repeat(900) });
  const values = payload.components[0].parameters.map((parameter) => parameter.text);

  assert.equal(values.every(Boolean), true);
  assert.equal(values[5].length, 220);
});

test("admin alert Meta definition is an exact Utility template with safe examples", () => {
  const definition = getNextGenAdminAlertMetaTemplateDefinition();

  assert.equal(definition.name, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_NAME);
  assert.equal(definition.language, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_LANGUAGE);
  assert.equal(definition.category, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_CATEGORY);
  assert.equal(definition.components[0].text, NEXTGEN_ADMIN_WHATSAPP_ALERT_TEMPLATE_BODY);
  assert.equal(definition.components[0].example.body_text[0].length, 9);
  assert.match(definition.components[0].example.body_text[0][1], /Dr Sara Khan/);
});

test("free-form fallback has the same useful information as the approved template", () => {
  const text = buildNextGenAdminAlertText({
    alertLabel: "Student asked about pricing",
    studentName: "Dr Sara",
    contactLabel: "+16475550123",
    examCountryLabel: "USMLE Step 1 · United States",
    interestsLabel: "Complete programme",
    latestMessage: "I need help choosing the correct plan.",
    coverageLabel: "Roadmap; 7-day demo; live session",
    meetingTime: "Not scheduled",
    nextStep: "Open the CRM and follow up.",
  });

  assert.match(text, /Student: Dr Sara/);
  assert.match(text, /Latest message: “I need help choosing the correct plan\.”/);
  assert.match(text, /Next action: Open the CRM and follow up\./);
  assert.doesNotMatch(text, /{{\d+}}/);
});
