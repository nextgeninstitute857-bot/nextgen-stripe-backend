import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  NEXTGEN_WHATSAPP_TEMPLATE_PACK,
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
  const sessionLink = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_live_session_link");
  assert.deepEqual(sessionLink?.variables, ["name", "topic", "live_session_link"]);
  const recordingLink = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_class_recording_link");
  assert.deepEqual(recordingLink?.variables, ["name", "full_session_name", "recording_link"]);
  assert.match(recordingLink?.body || "", /In case you missed today’s live session, you can catch up here/);
  assert.match(recordingLink?.body || "", /how you liked the teaching style/);
  assert.match(recordingLink?.body || "", /join the program/);
  assert.match(recordingLink?.body || "", /book a mentor call/);
  assert.doesNotMatch(recordingLink?.body || "", /correctly labelled|Google Meet|interested in joining/i);
  const meeting = NEXTGEN_WHATSAPP_TEMPLATE_PACK.find((item) => item.key === "nextgen_mentor_meeting_confirmation");
  assert.equal(meeting?.button?.text, "Join Meeting");
  assert.equal(meeting?.button?.url, "https://meet.google.com/{{meeting_code}}");
  assert.equal(meeting?.button?.dynamic, true);
  assert.equal(meeting?.button?.variable, "meeting_code");
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
