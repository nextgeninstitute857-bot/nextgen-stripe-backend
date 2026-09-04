import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildNextGenWhatsAppMetaTemplateSubmission,
  NEXTGEN_WHATSAPP_ACTIVE_TEMPLATE_KEYS,
  NEXTGEN_WHATSAPP_TEMPLATE_PACK,
  nextGenWhatsAppProviderTemplateName,
  normalizeMetaTemplateInventory,
  reconcileNextGenWhatsAppTemplatePack,
} from "../lib/crm-whatsapp-template-pack.js";

test("the managed WhatsApp pack contains the eight campaign templates", () => {
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.length, 8);
  assert.deepEqual(
    NEXTGEN_WHATSAPP_TEMPLATE_PACK.map((item) => item.key),
    [
      "nextgen_warm_welcome",
      "nextgen_live_session_invite",
      "nextgen_live_five_minute_reminder",
      "nextgen_live_session_link",
      "nextgen_class_recording_link",
      "nextgen_recording_notes_ready",
      "nextgen_payment_ready_followup",
      "nextgen_mentor_meeting_confirmation",
    ],
  );
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.some((item) => item.body.includes("1 PM")), false);
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.some((item) => item.body.includes("USMLE Step 1")), false);
  const canonical = reconcileNextGenWhatsAppTemplatePack([]).templates.filter((item) => item.managed_by === "nextgen_whatsapp_template_pack");
  assert.equal(canonical.every((item) => item.language_code === "en" && item.meta_language === "en"), true);
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.every((item) => item.variables.length === 0 || item.body.includes("{{")), true);
  assert.equal(NEXTGEN_WHATSAPP_ACTIVE_TEMPLATE_KEYS.length, 7);
  assert.equal(NEXTGEN_WHATSAPP_ACTIVE_TEMPLATE_KEYS.includes("nextgen_warm_welcome"), false);
  const welcome = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_warm_welcome");
  assert.equal(welcome?.campaign_slot, "fallback_first_outreach");
  assert.equal(welcome?.fallback_only, true);
  assert.equal(welcome?.normal_sequence, false);
  assert.match(welcome?.eligibility_rule || "", /no inbound WhatsApp conversation/i);
  const storedWelcome = canonical.find((item) => item.key === "nextgen_warm_welcome");
  assert.equal(storedWelcome?.fallback_only, true);
  assert.equal(storedWelcome?.normal_sequence, false);
  const invite = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_live_session_invite");
  assert.equal(nextGenWhatsAppProviderTemplateName(invite), "nextgen_live_session_invite_v2");
  assert.match(invite?.body || "", /remind you again five minutes before/i);
  assert.doesNotMatch(invite?.body || "", /experience our teaching quality|organised programme/i);
  const reminder = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_live_five_minute_reminder");
  assert.equal(reminder?.button?.text, "Open Live Sessions");
  assert.match(reminder?.body || "", /direct class link when the session begins/i);
  const sessionLink = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_live_session_link");
  assert.equal(nextGenWhatsAppProviderTemplateName(sessionLink), "nextgen_live_session_link_v3");
  assert.equal(sessionLink?.meta_category, "UTILITY");
  assert.deepEqual(sessionLink?.variables, ["name", "topic", "live_session_link"]);
  assert.match(sessionLink?.body || "", /Here’s your class link/);
  assert.match(sessionLink?.body || "", /See you in class/);
  assert.doesNotMatch(sessionLink?.body || "", /{{live_session_link}}$/);
  assert.doesNotMatch(sessionLink?.body || "", /Even 5|experience the NextGen teaching style/i);
  const recordingLink = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_class_recording_link");
  assert.equal(nextGenWhatsAppProviderTemplateName(recordingLink), "nextgen_class_recording_link_v2");
  assert.equal(recordingLink?.meta_category, "UTILITY");
  assert.deepEqual(recordingLink?.variables, ["name", "full_session_name", "recording_link"]);
  assert.match(recordingLink?.body || "", /NextGen LMS account/);
  assert.match(recordingLink?.body || "", /recording and notes/);
  assert.match(recordingLink?.body || "", /Open them here/);
  assert.doesNotMatch(recordingLink?.body || "", /join the program|book a mentor call/i);
  assert.doesNotMatch(recordingLink?.body || "", /correctly labelled|Google Meet|interested in joining/i);
  const notes = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_recording_notes_ready");
  assert.equal(notes?.button?.text, "Open Recording & Notes");
  assert.match(notes?.body || "", /notes for the following session are now available/i);
  const payment = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_payment_ready_followup");
  assert.match(payment?.body || "", /help you enroll/i);
  const meeting = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_mentor_meeting_confirmation");
  assert.equal(meeting?.button?.text, "Join Mentor Call");
  assert.equal(meeting?.button?.url, "https://meet.google.com/{{meeting_code}}");
  assert.equal(meeting?.button?.dynamic, true);
  assert.equal(meeting?.button?.variable, "meeting_code");
});

test("the seven approved rewrites produce positional Meta submissions without the fallback welcome", () => {
  const active = NEXTGEN_WHATSAPP_TEMPLATE_PACK.filter((item) => NEXTGEN_WHATSAPP_ACTIVE_TEMPLATE_KEYS.includes(item.key));
  assert.equal(active.length, 7);
  for (const definition of active) {
    const submission = buildNextGenWhatsAppMetaTemplateSubmission(definition);
    assert.equal(submission.name, nextGenWhatsAppProviderTemplateName(definition));
    assert.match(submission.language, /^en/);
    assert.ok(["MARKETING", "UTILITY"].includes(submission.category));
    const body = submission.components.find((item) => item.type === "BODY");
    assert.ok(body?.text);
    assert.doesNotMatch(body.text, /{{\s*[A-Za-z_]/);
    assert.match(body.text, /\{\{1\}\}/);
    assert.equal(body.example.body_text[0].length, definition.variables.length);
  }
  const mentor = buildNextGenWhatsAppMetaTemplateSubmission(active.find((item) => item.key === "nextgen_mentor_meeting_confirmation"));
  const mentorButton = mentor.components.find((item) => item.type === "BUTTONS")?.buttons?.[0];
  assert.equal(mentorButton?.url, "https://meet.google.com/{{1}}");
  assert.deepEqual(mentorButton?.example, ["abc-defg-hij"]);
});

test("reconciliation archives obsolete definitions without deleting history", () => {
  const existing = [
    { id: "old-demo", key: "two_day_lms_demo_access", active: true, status: "active", body: "old" },
    { id: "history", key: "unrelated_history", active: true, status: "active", body: "keep" },
  ];
  const result = reconcileNextGenWhatsAppTemplatePack(existing, { now: "2026-08-23T00:00:00.000Z" });

  assert.equal(result.templates.length, 10);
  assert.equal(result.templates.find((item) => item.id === "old-demo")?.status, "archived");
  assert.equal(result.templates.find((item) => item.id === "old-demo")?.active, false);
  assert.equal(result.templates.find((item) => item.id === "history")?.status, "active");
  assert.equal(result.templates.filter((item) => item.managed_by === "nextgen_whatsapp_template_pack").length, 8);
});

test("NextGen reconciliation never mutates an AylaMed template with the same key", () => {
  const aylaTemplate = {
    id: "ayla-same-key",
    brand_id: "brand_aylamed",
    key: "nextgen_warm_welcome",
    body: "AylaMed MCCQE reviewed copy",
    active: true,
    status: "active",
  };
  const result = reconcileNextGenWhatsAppTemplatePack([aylaTemplate], { now: "2026-09-04T00:00:00.000Z" });
  const preserved = result.templates.find((item) => item.id === aylaTemplate.id);
  const managed = result.templates.find((item) => item.managed_by === "nextgen_whatsapp_template_pack" && item.key === aylaTemplate.key);

  assert.deepEqual(preserved, aylaTemplate);
  assert.equal(managed?.brand_id, "brand_nextgen_usmle");
  assert.notEqual(managed?.id, aylaTemplate.id);
});

test("live Meta inventory is the only source of approved status", () => {
  const firstPass = reconcileNextGenWhatsAppTemplatePack([]);
  assert.equal(firstPass.templates.some((item) => item.meta_approved), false);

  const live = normalizeMetaTemplateInventory([
    { id: "1", name: "hello_world", status: "APPROVED", category: "UTILITY", language: "en_US" },
    { id: "2", name: "nextgen_warm_welcome", status: "APPROVED", category: "MARKETING", language: "en_US" },
    { id: "3", name: "nextgen_live_session_invite", status: "PENDING", category: "MARKETING", language: "en_US" },
  ]);
  const synced = reconcileNextGenWhatsAppTemplatePack(firstPass.templates, {
    liveTemplates: live,
    liveWasChecked: true,
    now: "2026-08-23T01:00:00.000Z",
  });

  assert.equal(synced.liveApprovedCount, 1);
  assert.equal(synced.templates.find((item) => item.key === "nextgen_warm_welcome")?.meta_approved, true);
  assert.equal(synced.templates.find((item) => item.key === "nextgen_live_session_invite")?.meta_approved, false);
  assert.equal(synced.templates.find((item) => item.key === "nextgen_recording_notes_ready")?.meta_status, "draft");
});

test("mentor meeting template sends a validated dynamic Google Meet button", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /function normalizeGoogleMeetCode/);
  assert.match(server, /sub_type: "url"/);
  assert.match(server, /parameters: \[\{ type: "text", text: meetingCode \}\]/);
  assert.match(server, /Add a valid Google Meet link before sending the mentor meeting confirmation/);
  assert.match(server, /confirmation: settings\.google_meet_confirmation_template_key \|\| "nextgen_mentor_meeting_confirmation"/);
});
