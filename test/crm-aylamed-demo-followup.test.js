import assert from "node:assert/strict";
import test from "node:test";
import { recordExperienceShares, experienceFollowupEligibility, buildExperienceCheckinPrompt, validateExperienceCheckin } from "../lib/crm-experience-followup.js";
import { runExperienceCheckin } from "../lib/crm-experience-scheduler.js";
import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";
import { buildAylaEngagementMessages } from "../lib/aylamed-exam-continuity.js";

const starts = "2026-09-04T07:00:00.000Z";
const expiry = "2026-09-04T12:00:00.000Z";
const now = Date.parse(expiry);
const incoming = { id: "in-1", text: "Please email my MCCQE demo", created_at: "2026-09-04T06:59:00.000Z" };
const outgoing = { id: "out-1", text: "Your demo access has been emailed", created_at: starts };
const resource = {
  kind: "aylamed_demo", id: "issuance-1", issuance_id: "issuance-1", user_id: "user-1", enrollment_id: "enrollment-1",
  exam_track_id: "mccqe", starts_at: starts, expires_at: expiry,
  title: "five-hour AylaMed MCCQE demo", url: "https://mccqe.aylamedapp.com/login", channel: "whatsapp",
};
function leadWithDemo() {
  const lead = { id: "lead-1", brand_id: "brand_aylamed", exam_track_id: "mccqe", ai_mode: "auto", payment_status: "unpaid" };
  recordExperienceShares({ lead, resources: [resource], inbound: incoming, now: starts });
  return lead;
}
const eligibility = (lead, extra = {}) => experienceFollowupEligibility({ lead, latestInbound: incoming, latestOutbound: outgoing, channel: "whatsapp", now, ...extra });

test("private MCCQE follow-up uses persisted five-hour expiry, not the generic six-hour minimum", () => {
  const lead = leadWithDemo();
  const item = lead.ayla_experience_followups[0];
  assert.equal(item.due_at, expiry);
  assert.equal(item.issuance_id, resource.id);
  assert.equal(item.user_id, resource.user_id);
  assert.equal(eligibility(lead, { now: now - 1 }).reason, "not_due");
  assert.equal(eligibility(lead).ok, true);
  const nextgen = { id: "ng-1" };
  recordExperienceShares({ lead: nextgen, resources: [{ kind: "demo", title: "NextGen demo", url: "https://nextgenusmle.live/demo" }], inbound: incoming, now: starts, waitHours: 5 });
  assert.equal(nextgen.ayla_experience_followups[0].due_at, "2026-09-04T13:00:00.000Z");
});

test("same issuance cannot reset expiry even when its label or login query changes", () => {
  const lead = leadWithDemo();
  const before = structuredClone(lead.ayla_experience_followups);
  assert.deepEqual(recordExperienceShares({ lead, resources: [{ ...resource, title: "MCCQE demo", url: resource.url + "?exam=mccqe" }], now: expiry }), []);
  assert.deepEqual(lead.ayla_experience_followups, before);
});

test("incomplete or cross-brand trial records cannot create a timer", () => {
  for (const patch of [
    { starts_at: null }, { expires_at: "invalid" }, { expires_at: "2026-09-04T14:00:00Z" },
    { id: null, issuance_id: null }, { user_id: null }, { enrollment_id: null }, { exam_track_id: "usmle_step1" },
    { url: "https://nextgenusmle.live/demo" }, { url: "https://someone:mypass@mccqe.aylamedapp.com/login" },
  ]) {
    const lead = { id: "lead-1", brand_id: "brand_aylamed" };
    assert.deepEqual(recordExperienceShares({ lead, resources: [{ ...resource, ...patch }], now: starts }), []);
  }
  assert.deepEqual(recordExperienceShares({ lead: { brand_id: "brand_nextgen_usmle" }, resources: [resource], now: starts }), []);
});

test("MCCQE check-in copy stays AylaMed and never uses a NextGen template outside the session window", () => {
  const lead = leadWithDemo();
  const item = lead.ayla_experience_followups[0];
  assert.match(buildExperienceCheckinPrompt({ item }), /Ayla from AylaMed.*private five-hour MCCQE/);
  assert.doesNotMatch(buildExperienceCheckinPrompt({ item }), /NextGen|USMLE|7-day/);
  assert.equal(validateExperienceCheckin(`Did you have a chance to explore your ${item.title}?`, item), true);
  assert.equal(validateExperienceCheckin(`NextGen here! Did you explore your ${item.title}?`, item), false);
  assert.equal(eligibility(lead, { now: Date.parse(incoming.created_at) + 24 * 3600000, templatePolicy: { enabled: true, ownerApproved: true } }).reason, "aylamed_experience_template_required");
});

test("legacy generic resources on an AylaMed lead cannot enter NextGen copy or template handling", () => {
  for (const kind of ["demo", "recording", "live_session"]) {
    const lead = leadWithDemo();
    lead.ayla_experience_followups[0].kind = kind;
    assert.equal(eligibility(lead).reason, "aylamed_demo_resource_required");
  }
  const lead = leadWithDemo();
  lead.ayla_experience_followups.push({ ...lead.ayla_experience_followups[0], id: "legacy-nextgen", kind: "demo", shared_at: "2026-09-04T08:00:00Z" });
  assert.equal(eligibility(lead).ok, true, "a legacy resource must not hide the real private demo timer");
  assert.equal(eligibility(lead).item.issuance_id, resource.issuance_id);
});

function harness(overrides = {}) {
  let db = { leads: [leadWithDemo()], incoming: structuredClone(incoming), outgoing: structuredClone(outgoing), sent: [], reviews: [] };
  let generated = 0;
  let held = false;
  let queue = Promise.resolve();
  const phases = [];
  const deps = {
    leadId: "lead-1", read: async () => structuredClone(db),
    context: (data, id) => ({ db: data, lead: data.leads.find(row => row.id === id), latestInbound: data.incoming, latestOutbound: data.outgoing, channel: "whatsapp", futureFollowups: [] }),
    mutate: fn => {
      const result = queue.then(async () => { const mutation = await mutateJsonCopyOnWrite(db, fn); db = mutation.value; return mutation.result; });
      queue = result.catch(() => {});
      return result;
    },
    beforeSend: async ({ phase }) => { phases.push(phase); return { ok: true }; },
    generate: async (_, item) => { generated++; return `Did you have a chance to explore your ${item.title}?`; },
    send: async ({ db: data, reply }) => { data.sent.push(reply); return { status: "sent", log: { id: "checkin-1", provider_message_id: "provider-1", sent_at: expiry } }; },
    review: (data, lead, item, reason) => { item.review_reason = reason; data.reviews.push(reason); },
    lock: () => { if (held) return { locked: false }; held = true; return { locked: true, key: "lead-1" }; },
    unlock: () => { held = false; }, now: () => now, ...overrides,
  };
  return { deps, get db() { return db; }, get generated() { return generated; }, phases, run: () => runExperienceCheckin(deps) };
}

test("unverified or unavailable purchase checks fail closed before spending AI or sending", async () => {
  for (const beforeSend of [undefined, async () => undefined, async () => ({ ok: false, reason: "unverified_link" }), async () => { throw Error("provider unavailable"); }]) {
    const h = harness({ beforeSend });
    assert.equal((await h.run()).sent, false);
    assert.equal(h.generated, 0);
    assert.equal(h.db.sent.length, 0);
  }
});

test("paid before generation permanently cancels this trial check-in", async () => {
  const h = harness({ beforeSend: async () => ({ ok: false, reason: "already_purchased", cancel: true }) });
  assert.equal((await h.run()).reason, "already_purchased");
  assert.equal(h.generated, 0);
  assert.equal(h.db.leads[0].ayla_experience_followups[0].status, "cancelled");
  assert.equal((await h.run()).sent, false);
});

test("purchase during generation or after reservation cancels without an outdated WhatsApp message", async () => {
  for (const target of ["before_reservation", "before_send"]) {
    const h = harness({ beforeSend: async ({ phase, db, context }) => {
      if (phase !== "before_generation") assert.equal(context.lead, db.leads[0]);
      return phase === target ? { ok: false, reason: "already_purchased", cancel: true } : { ok: true };
    } });
    assert.equal((await h.run()).reason, "already_purchased");
    assert.equal(h.generated, 1);
    assert.equal(h.db.sent.length, 0);
    const item = h.db.leads[0].ayla_experience_followups[0];
    assert.equal(item.status, "cancelled");
    assert.equal(item.reservation_id, undefined);
  }
});

test("accepted check-in verifies entitlement at all three stages and sends once across retries", async () => {
  const h = harness();
  const results = await Promise.all([h.run(), h.run()]);
  assert.equal(results.filter(result => result.sent).length, 1);
  assert.deepEqual(h.phases, ["before_generation", "before_reservation", "before_send"]);
  assert.equal(h.db.sent.length, 1);
  assert.equal((await h.run()).sent, false);
  assert.equal(h.db.leads[0].ayla_experience_followups[0].checkin_sent_at, expiry);
});

test("late entitlement failures have a durable cooldown instead of regenerating on each heartbeat", async () => {
  for (const target of ["before_reservation", "before_send"]) {
    for (const throws of [false, true]) {
      const h = harness({ beforeSend: async ({ phase }) => {
        if (phase !== target) return { ok: true };
        if (throws) throw Error("entitlement service unavailable");
        return { ok: false, reason: "entitlement_unavailable" };
      } });
      assert.equal((await h.run()).sent, false);
      const item = h.db.leads[0].ayla_experience_followups[0];
      assert.equal(item.last_attempt_at, expiry);
      assert.equal(item.attempt_count, 1);
      assert.equal(item.reservation_id, undefined);
      assert.equal(item.review_reason, "aylamed_demo_authorization_needs_review");
      assert.equal((await h.run()).reason, "attempt_cooldown");
      assert.equal(h.generated, 1);
      assert.equal(h.db.sent.length, 0);
    }
  }
});

test("uncertain provider delivery stays in review and is not automatically resent", async () => {
  const h = harness({ send: async () => { throw Error("unknown outcome"); } });
  assert.equal((await h.run()).sent, false);
  assert.equal(h.db.leads[0].ayla_experience_followups[0].status, "needs_delivery_review");
  assert.equal((await h.run()).sent, false);
  assert.equal(h.generated, 1);
});

test("private CRM trials do not also send day-based expiry, renewal or reactivation emails", () => {
  for (const time of ["2026-09-04T09:00:00Z", "2026-09-04T14:00:00Z", "2026-09-11T14:00:00Z"]) {
    const options = {
      now: time, user: { name: "Test Student", email: "demo@example.test" }, student: { id: "student-1", examTrackId: "mccqe", timezone: "UTC" },
      preferences: { accountEmailEnabled: true, reactivationEmailOptIn: true },
      enrollment: { id: "enrollment-1", access_expires_at: expiry, source: "crm_mccqe_demo", type: "demo", is_demo: true },
    };
    assert.equal(buildAylaEngagementMessages(options).messages.some(row => ["renewal_notice", "access_expired", "reactivation"].includes(row.kind)), false);
    assert.equal(buildAylaEngagementMessages({ ...options, enrollment: { ...options.enrollment, source: "ordinary_enrollment" } }).messages.length, 1);
  }
});
