import test from "node:test";
import assert from "node:assert/strict";
import { EXPERIENCE_TEMPLATE, experienceTemplateGate, experienceTemplateMessage } from "../lib/crm-experience-template.js";

const now = Date.parse("2026-08-28T12:00:00Z");
const ctx = (patch = {}) => ({ now, enabled: true, ownerApproved: true, checkedAt: new Date(now).toISOString(),
  template: { id: "meta-test", name: EXPERIENCE_TEMPLATE.name, language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: EXPERIENCE_TEMPLATE.body }] },
  lead: { phone: "+447700900123", whatsapp_followup_consent: { status: "granted", scope: "programme_experience", source: "student_message", evidence: "Yes, please follow up about the demo.", recorded_at: new Date(now - 3600000).toISOString() } }, ...patch });

test("approval alone does not enable outside-window messages", () => {
  assert.equal(experienceTemplateGate(ctx({ enabled: false })).reason, "experience_template_disabled");
  assert.equal(experienceTemplateGate(ctx({ ownerApproved: false })).reason, "experience_template_owner_approval_required");
  assert.equal(experienceTemplateGate(ctx()).ok, true);
});
test("requires fresh exact Meta approval, not a local approved flag or wrong purpose", () => {
  for (const patch of [{ status: "PENDING" }, { language: "en_GB" }, { name: "nextgen_warm_welcome" }, { category: "UTILITY" }, { components: [{ type: "BODY", text: "Different copy" }] }]) {
    assert.equal(experienceTemplateGate(ctx({ template: { ...ctx().template, ...patch } })).ok, false);
  }
  assert.equal(experienceTemplateGate(ctx({ checkedAt: new Date(now - 6 * 60000).toISOString() })).reason, "experience_template_approval_stale");
});
test("ad attribution, country and an incoming hi are not follow-up consent", () => {
  for (const lead of [{ phone: "+447700900123", opt_in_status: "platform_inbound" }, { phone: "+447700900123", opt_in_status: "meta_form_opt_in" }, { ...ctx().lead, whatsapp_followup_consent: { status: "granted" } }]) {
    assert.equal(experienceTemplateGate(ctx({ lead })).reason, "experience_followup_consent_required");
  }
  assert.equal(experienceTemplateGate(ctx({ lead: { ...ctx().lead, whatsapp_followup_consent: { ...ctx().lead.whatsapp_followup_consent, revoked_at: new Date(now).toISOString() } } })).ok, false);
});
test("US numbering restrictions and unknown +1 region never turn into blind retries", () => {
  for (const phone of ["+12025550123", "+16473450891", "unknown", ""]) {
    assert.equal(experienceTemplateGate(ctx({ lead: { ...ctx().lead, phone } })).ok, false);
  }
});
test("outbound payload uses the exact template and two bounded plain-text variables", () => {
  const item = { kind: "recording", title: "Central Nervous System — Day 2" };
  const msg = experienceTemplateMessage({ name: "Sarah" }, item);
  assert.equal(msg.templateName, "nextgen_experience_checkin");
  assert.equal(msg.components[0].parameters.length, 2);
  assert.match(msg.text, /Central Nervous System — Day 2/);
  assert.match(msg.text, /Reply STOP/);
  assert.throws(() => experienceTemplateMessage({ name: "Sarah" }, { title: "https://evil.invalid/" }), /title/i);
});
