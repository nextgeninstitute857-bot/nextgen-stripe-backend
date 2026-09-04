import test from "node:test";
import assert from "node:assert/strict";
import { mccqeDemoEnabled, validateMccqeDemoRequest, mccqeDemoIssuanceId, findMccqeDemoReplay, mccqeDemoPurchaseState,
  mccqeDemoEmailAccepted, mccqeDemoResource, mccqeDemoSendEligibility, cancelMccqeDemoSales, preserveMccqeDemoLedgerSnapshot } from "../lib/crm-aylamed-demo-lifecycle.js";

export function fixture() {
  const starts = "2026-09-04T12:00:00.000Z", expires = "2026-09-04T17:00:00.000Z";
  const issuance = { id: "issuance-1", request_key: "request-001", crm_lead_id: "lead-1", brand_id: "brand_aylamed", user_id: "user-1", enrollment_id: "enrollment-1",
    email: "doctor@example.com", exam_track_id: "mccqe", starts_at: starts, expires_at: expires,
    login_url: "https://mccqe.aylamedapp.com/login", email_delivery_status: "accepted" };
  const db = { aylaCrmDemoIssuances: { [issuance.id]: issuance }, aylaUsers: { "user-1": { id: "user-1", email: issuance.email, status: "active" } },
    aylaEnrollments: { "enrollment-1": { id: "enrollment-1", user_id: "user-1", exam_track_id: "mccqe", source: "crm_mccqe_demo", type: "demo", is_demo: true,
      access_granted: true, access_starts_at: starts, access_expires_at: expires } }, aylaPayments: {} };
  const resource = mccqeDemoResource(issuance);
  const item = { ...resource, resource_id: resource.id, id: "checkin-1", status: "pending", reservation_id: "reserve-1" };
  const lead = { id: "lead-1", brand_id: "brand_aylamed", exam_track_id: "mccqe", email: issuance.email, ayla_user_id: "user-1", ayla_experience_followups: [item] };
  return { db, lead, item, issuance, now: Date.parse(expires) };
}

test("MCCQE lifecycle defaults off and admin mode requires exact ownership, email, exam and replay key", () => {
  assert.equal(mccqeDemoEnabled({}), false);
  assert.equal(mccqeDemoEnabled({ AYLAMED_MCCQE_DEMO_FLOW_ENABLED: "true" }), true);
  const { lead } = fixture();
  const body = { brand_id: "brand_aylamed", crm_lead_id: lead.id, email: lead.email, exam_track_id: "mccqe", idempotency_key: "request-001" };
  assert.equal(validateMccqeDemoRequest(body, lead).email, lead.email);
  for (const patch of [{ brand_id: "brand_nextgen_usmle" }, { email: "another@example.com" }, { exam_track_id: "usmle_step_1" }, { idempotency_key: "" }, { return_password: true }]) {
    assert.throws(() => validateMccqeDemoRequest({ ...body, ...patch }, lead));
  }
  assert.throws(() => validateMccqeDemoRequest(body, { ...lead, brand_id: "brand_nextgen_usmle" }));
});

test("one user/exam issuance cannot be recreated by a different request key or second lead", () => {
  const { db, issuance } = fixture();
  const request = { ...issuance, request_key: "new-request" };
  assert.equal(findMccqeDemoReplay(db, request, "user-1").id, issuance.id);
  assert.throws(() => findMccqeDemoReplay(db, { ...request, crm_lead_id: "another-lead" }, "user-1"));
  assert.throws(() => findMccqeDemoReplay(db, { ...request, request_key: "request-001", email: "other@example.com" }));
  assert.equal(mccqeDemoIssuanceId("user-1"), mccqeDemoIssuanceId("user-1"));
  assert.notEqual(mccqeDemoIssuanceId("user-1"), mccqeDemoIssuanceId("user-2"));
});

test("paid suppression uses exact Ayla user/exam; free/manual/demo grants alone are not purchases", () => {
  const f = fixture();
  assert.equal(mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, false);
  f.db.aylaPayments.wrong = { user_id: "other", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
  f.db.aylaPayments.step1 = { user_id: "user-1", exam_track_id: "usmle_step_1", status: "completed", amount_cents: 4000 };
  assert.equal(mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, false);
  f.db.aylaEnrollments.manual = { id: "manual", user_id: "user-1", exam_track_id: "mccqe", type: "manual", status: "active", access_granted: true };
  assert.deepEqual([mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, mccqeDemoPurchaseState(f.db, "user-1", f.now).active_access], [false, true]);
  f.db.aylaPayments.upgrade = { id: "upgrade", user_id: "user-1", enrollment_id: "enrollment-1", status: "completed", amount_cents: 4000, source: "admin_access_upgrade" };
  assert.equal(mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, true);
});

test("verified 100 percent coupon/free checkout suppresses even after paid entitlement expires", () => {
  const f = fixture();
  f.db.aylaEnrollments.paid = { id: "paid", user_id: "user-1", exam_track_id: "mccqe", type: "paid", is_demo: false, access_granted: true, access_expires_at: "2026-08-01T00:00:00Z" };
  f.db.aylaPayments.free = { id: "free", user_id: "user-1", enrollment_id: "paid", status: "completed", amount_cents: 0, source: "aylamed_free_checkout" };
  assert.equal(mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, true);
  f.db.aylaPayments.free.source = "admin_access_invitation";
  assert.equal(mccqeDemoPurchaseState(f.db, "user-1", f.now).paid, false);
});

test("only provider-accepted email creates a resource; SMTP rejection is not accepted", () => {
  assert.equal(mccqeDemoEmailAccepted({ provider: "smtp", accepted: ["doctor@example.com"], rejected: [] }, "doctor@example.com"), true);
  assert.equal(mccqeDemoEmailAccepted({ provider: "smtp", accepted: [], rejected: ["doctor@example.com"] }, "doctor@example.com"), false);
  assert.equal(mccqeDemoEmailAccepted({ provider: "resend", id: "provider-id" }), true);
  assert.equal(mccqeDemoEmailAccepted({ provider: "sendgrid", status: 202 }), true);
  assert.equal(mccqeDemoEmailAccepted({ provider: "sendgrid", status: 200 }), false);
  const { issuance } = fixture();
  assert.equal(mccqeDemoResource({ ...issuance, email_delivery_status: "reserved" }), null);
  assert.equal(mccqeDemoResource({ ...issuance, email_delivery_status: "uncertain" }), null);
});

test("expiry gate checks current ledger, exact five-hour window, account, enrollment and purchase", () => {
  const f = fixture();
  assert.equal(mccqeDemoSendEligibility(f).ok, true);
  assert.equal(mccqeDemoSendEligibility({ ...f, now: f.now - 1 }).reason, "aylamed_demo_not_expired");
  for (const mutate of [
    (v) => { v.lead.brand_id = "brand_nextgen_usmle"; },
    (v) => { v.item.user_id = "another"; },
    (v) => { v.db.aylaEnrollments["enrollment-1"].access_expires_at = "2026-09-04T18:00:00Z"; },
    (v) => { v.db.aylaUsers["user-1"].status = "disabled"; },
    (v) => { v.issuance.email_delivery_status = "uncertain"; },
  ]) { const value = fixture(); mutate(value); assert.equal(mccqeDemoSendEligibility(value).ok, false); }
  f.db.aylaPayments.payment = { id: "payment", user_id: "user-1", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
  assert.equal(mccqeDemoSendEligibility(f).cancel, true);
  assert.equal(cancelMccqeDemoSales(f.lead), true);
  assert.equal(f.item.status, "cancelled");
  assert.equal(f.lead.paid, true);
  assert.equal(cancelMccqeDemoSales({ ...f.lead, brand_id: "brand_nextgen_usmle", paid: false }), false);
});

test("stale legacy snapshots cannot erase issuance or newly-created trial account, while intentional account deletion is preserved", () => {
  const f = fixture();
  const merged = preserveMccqeDemoLedgerSnapshot(f.db, { aylaUsers: {}, aylaEnrollments: {} });
  assert.equal(merged.aylaCrmDemoIssuances["issuance-1"].email_delivery_status, "accepted");
  assert.ok(merged.aylaUsers["user-1"]);
  const deliberateDelete = preserveMccqeDemoLedgerSnapshot(f.db, { aylaCrmDemoIssuances: f.db.aylaCrmDemoIssuances, aylaUsers: {}, aylaEnrollments: {} });
  assert.equal(deliberateDelete.aylaUsers["user-1"], undefined);
});
