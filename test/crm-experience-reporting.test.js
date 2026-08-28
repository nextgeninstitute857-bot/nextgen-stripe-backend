import test from "node:test";
import assert from "node:assert/strict";
import { experienceQueueRows, experienceTemplateProposal } from "../lib/crm-experience-reporting.js";

test("queue is read-only and separates accepted, delivered, read and actual student feedback", () => {
  const lead = { id: "test", name: "Synthetic Student", ayla_experience_followups: [
    { id: "one", title: "CNS Day 2", status: "checkin_sent", message_id: "m1", checkin_sent_at: "2026-08-28T18:00Z", outcome: "unknown" },
    { id: "two", title: "Demo", status: "checkin_sent", provider_message_id: "p2", checkin_sent_at: "2026-08-28T18:00Z" },
    { id: "three", title: "CNS Day 3", status: "pending" },
  ] };
  const original = structuredClone(lead);
  const rows = experienceQueueRows({ leads: [lead], logs: [{ id: "m1", status: "read", read_at: "2026-08-28T19:00Z" }], context: () => ({}), eligibility: () => ({ ok: false, reason: "experience_template_required" }) });
  assert.equal(rows[0].experiences[0].delivery, "read");
  assert.equal(rows[0].experiences[0].outcome, "unknown", "reading a WhatsApp message is not watching a recording");
  assert.equal(rows[0].experiences[1].delivery, "accepted");
  assert.equal(rows[0].experiences[2].delivery, "not_sent");
  assert.match(rows[0].reason_label, /outside 24 hours/);
  assert.deepEqual(lead, original);
});

test("global worker/provider blocks cannot appear as ready-to-send", () => {
  const [row] = experienceQueueRows({ leads: [{ id: "test", ayla_experience_followups: [] }], context: () => ({}), eligibility: () => ({ ok: true }), blocked: "provider_blocked" });
  assert.equal(row.eligible, false);
  assert.match(row.reason_label, /delivery needs attention/);
  assert.equal(experienceTemplateProposal.enabled, false);
  assert.equal(experienceTemplateProposal.status, "owner_approval_required");
});
