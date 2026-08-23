import test from "node:test";
import assert from "node:assert/strict";

import {
  NEXTGEN_WHATSAPP_TEMPLATE_PACK,
  normalizeMetaTemplateInventory,
  reconcileNextGenWhatsAppTemplatePack,
} from "../lib/crm-whatsapp-template-pack.js";

test("the managed WhatsApp pack contains the approved six templates", () => {
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.length, 6);
  assert.deepEqual(
    NEXTGEN_WHATSAPP_TEMPLATE_PACK.map((item) => item.key),
    [
      "nextgen_warm_welcome",
      "nextgen_live_session_invite",
      "nextgen_live_five_minute_reminder",
      "nextgen_recording_notes_ready",
      "nextgen_payment_ready_followup",
      "nextgen_mentor_meeting_confirmation",
    ],
  );
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.some((item) => item.body.includes("1 PM")), false);
  assert.equal(NEXTGEN_WHATSAPP_TEMPLATE_PACK.some((item) => item.body.includes("USMLE Step 1")), false);
});

test("reconciliation archives obsolete definitions without deleting history", () => {
  const existing = [
    { id: "old-demo", key: "two_day_lms_demo_access", active: true, status: "active", body: "old" },
    { id: "history", key: "unrelated_history", active: true, status: "active", body: "keep" },
  ];
  const result = reconcileNextGenWhatsAppTemplatePack(existing, { now: "2026-08-23T00:00:00.000Z" });

  assert.equal(result.templates.length, 8);
  assert.equal(result.templates.find((item) => item.id === "old-demo")?.status, "archived");
  assert.equal(result.templates.find((item) => item.id === "old-demo")?.active, false);
  assert.equal(result.templates.find((item) => item.id === "history")?.status, "active");
  assert.equal(result.templates.filter((item) => item.managed_by === "nextgen_whatsapp_template_pack").length, 6);
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
