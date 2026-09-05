import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as lifecycle from "../lib/crm-aylamed-demo-lifecycle.js";
import { recordExperienceShares } from "../lib/crm-experience-followup.js";

const key = "AYLAMED_MCCQE_DEMO_PILOT_LEAD_ID";
const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function scope(t, value) {
  const keys = [key, "AYLAMED_MCCQE_DEMO_FLOW_ENABLED"];
  const saved = keys.map((name) => [name, Object.hasOwn(process.env, name), process.env[name]]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  process.env.AYLAMED_MCCQE_DEMO_FLOW_ENABLED = "true";
  t.after(() => { for (const [name, present, old] of saved) { if (present) process.env[name] = old; else delete process.env[name]; } });
}
function fixture(id = "pilot") {
  const starts = "2026-09-05T07:00:00.000Z", expires = "2026-09-05T12:00:00.000Z";
  const issuance = { id: `issue-${id}`, crm_lead_id: id, brand_id: "brand_aylamed", user_id: `user-${id}`, enrollment_id: `enroll-${id}`,
    email: `${id}@example.test`, exam_track_id: "mccqe", starts_at: starts, expires_at: expires,
    source_inbound_id: `in-${id}`, email_delivery_at: starts, login_url: "https://mccqe.aylamedapp.com/login", email_delivery_status: "accepted" };
  const item = { ...lifecycle.mccqeDemoResource(issuance), id: `check-${id}`, resource_id: issuance.id, reservation_id: "reservation", status: "pending" };
  const lead = { id, brand_id: "brand_aylamed", email: issuance.email, exam_track: "mccqe", ayla_user_id: issuance.user_id, ayla_experience_followups: [item] };
  const db = { aylaCrmDemoIssuances: { [issuance.id]: issuance }, aylaUsers: { [issuance.user_id]: { id: issuance.user_id, email: issuance.email } },
    aylaEnrollments: { [issuance.enrollment_id]: { id: issuance.enrollment_id, user_id: issuance.user_id, exam_track_id: "mccqe", type: "demo", is_demo: true,
      source: "crm_mccqe_demo", access_granted: true, access_starts_at: starts, access_expires_at: expires } }, aylaPayments: {} };
  return { db, lead, item, issuance, now: Date.parse(expires) };
}

test("pilot is optional, exact/case-sensitive and present malformed config fails closed", () => {
  assert.deepEqual(lifecycle.mccqeDemoPilotStatus({}), { restricted: false, valid: true, leadId: "" });
  assert.equal(lifecycle.mccqeDemoPilotEligibility("anything", {}).ok, true);
  const env = { [key]: "  Pilot-123  " };
  assert.equal(lifecycle.mccqeDemoPilotEligibility("Pilot-123", env).ok, true);
  for (const id of ["pilot-123", "Pilot-123-more", " Pilot-123", "different"]) assert.equal(lifecycle.mccqeDemoPilotEligibility(id, env).ok, false);
  for (const value of ["", "  ", "*", "pilot-*", "pilot,other", "pilot other", "^pilot$", "all", "null", undefined, null, 42, "a".repeat(161)]) {
    const config = { [key]: value };
    assert.equal(lifecycle.mccqeDemoPilotStatus(config).restricted, true);
    assert.equal(lifecycle.mccqeDemoPilotEligibility("pilot", config).reason, "aylamed_demo_pilot_configuration_invalid");
  }
});

test("pilot restricts exact guarded requests and expiry while all ordinary identity/payment guards remain", (t) => {
  scope(t, "pilot");
  const f = fixture(), other = fixture("other");
  const request = (lead) => ({ crm_lead_id: lead.id, brand_id: lead.brand_id, exam_track_id: "mccqe", email: lead.email, idempotency_key: "request-001" });
  assert.equal(lifecycle.validateMccqeDemoRequest(request(f.lead), f.lead).crm_lead_id, "pilot");
  assert.throws(() => lifecycle.validateMccqeDemoRequest(request(other.lead), other.lead), /pilot scope/);
  assert.throws(() => lifecycle.validateMccqeDemoRequest({ ...request(f.lead), email: "wrong@example.test" }, f.lead), /email/);
  assert.equal(lifecycle.mccqeDemoSendEligibility(f).ok, true);
  assert.equal(lifecycle.mccqeDemoSendEligibility(other).reason, "aylamed_demo_pilot_lead_restricted");
  assert.equal(lifecycle.mccqeDemoSendEligibility({ item: { kind: "demo" }, lead: { id: "nextgen", brand_id: "brand_nextgen_usmle" } }).ok, true);
  f.db.aylaPayments.paid = { user_id: f.lead.ayla_user_id, exam_track_id: "mccqe", payment_status: "paid", amount_cents: 4000 };
  assert.equal(lifecycle.mccqeDemoSendEligibility(f).reason, "aylamed_demo_purchased");
  process.env.AYLAMED_MCCQE_DEMO_FLOW_ENABLED = "false";
  assert.throws(() => lifecycle.assertMccqeDemoDispatchAllowed("pilot"), /not enabled/);
});

test("single-use capability cannot bypass pilot scope or an awaited verification-time change", async (t) => {
  scope(t, "pilot");
  const f = fixture(), other = fixture("other");
  let release;
  const guard = lifecycle.createMccqeDemoOutboundGuard({ verify: () => new Promise((resolve) => { release = resolve; }) });
  assert.throws(() => guard.issue({ ...other, text: "check", to: "18250000002" }), /pilot scope/);
  const capability = guard.issue({ ...f, text: "check", to: "18250000001" });
  const result = guard.consume(capability, { lead: f.lead, text: "check", to: "18250000001", channel: "whatsapp" });
  await Promise.resolve();
  process.env[key] = "other";
  release({ ok: true });
  assert.equal((await result).reason, "aylamed_demo_pilot_lead_restricted");
  assert.equal((await guard.consume(capability, { lead: f.lead })).reason, "aylamed_demo_capability_invalid");
});

test("actual all-lead follow-up scan includes only pilot Ayla records and leaves NextGen unchanged", async (t) => {
  scope(t, "pilot");
  const leads = [fixture("other").lead, fixture().lead, { id: "nextgen", brand_id: "brand_nextgen_usmle", ayla_experience_followups: [{ kind: "demo" }] }];
  const called = [], db = { leads, settings: {} };
  const context = vm.createContext({ ...lifecycle, AYLAMED_BRAND_ID: "brand_aylamed", safeArray: (v) => Array.isArray(v) ? v : [],
    getLeadByAnyId: (d, id) => d.leads.find((row) => row.id === id), ngAylaPickSettings: () => ({}), ngLeadConversationMessages: () => [],
    resolveCrmChannelForConversation: () => "whatsapp", ngLatestInbound: () => ({}), ngLatestOutbound: () => ({}), ngAffArray: (d, name) => d[name] || [],
    ngExperienceTemplatePolicy: () => null, ngExperienceFollowupsEnabled: () => true, ng41IsSuppressed: () => false, ngAylaFindActiveGoogleMeetAppointment: () => null,
    ngReconcileAylaMccqeDemoCrmLinks: async () => {}, ngWhatsAppProviderBlockStatus: () => ({ blocked: false }), isAIConfigured: () => true, readCrmDb: async () => db,
    experienceFollowupEligibility: () => ({ ok: true }), mutateCrmDb: () => {}, ngAylaMccqeDemoBeforeSend: () => {}, ngReleaseAiAutoLock: () => {}, ngReviewExperienceFollowup: () => {},
    runExperienceCheckin: async ({ leadId }) => { called.push(leadId); return { lead_id: leadId }; },
  });
  vm.runInContext(section("function ngExperienceContext(", "function ngReviewExperienceFollowup(")
    + section("async function ngRunExperienceFollowups(", 'app.get("/admin/crm/automation/experience-followups"'), context);
  await context.ngRunExperienceFollowups({ limit: 10 });
  assert.deepEqual(called, ["pilot", "nextgen"]);
  process.env[key] = " "; called.length = 0;
  await context.ngRunExperienceFollowups({ limit: 10 });
  assert.deepEqual(called, ["nextgen"]);
});

test("actual reconciliation does not reconstruct or cancel nonpilot follow-ups", async (t) => {
  scope(t, "pilot");
  const f = fixture(), other = fixture("other");
  const db = { leads: [f.lead, other.lead], conversations: [f, other].map((v) => ({ id: v.issuance.source_inbound_id, lead_id: v.lead.id, direction: "inbound", created_at: v.issuance.starts_at })) };
  f.lead.ayla_experience_followups = [];
  const untouched = JSON.stringify(other.lead), ayla = f.db;
  for (const name of ["aylaCrmDemoIssuances", "aylaUsers", "aylaEnrollments"]) Object.assign(ayla[name], other.db[name]);
  const context = vm.createContext({ ...lifecycle, recordExperienceShares, AYLAMED_BRAND_ID: "brand_aylamed", Date,
    aylaWriteQueue: Promise.resolve(), readAylaDb: async () => ayla, mutateCrmDb: async (fn) => fn(db), ensureCrmArray: (d, name) => d[name] ||= [],
    normalizeEmail: (v) => String(v).toLowerCase(), ngLeadConversationMessages: (d, id) => d.conversations.filter((row) => row.lead_id === id),
    ngIsOutboundMessage: (row) => row.direction === "outbound",
  });
  vm.runInContext(section("function ngAylaMccqeDemoPublicIssuance(", "async function ngAylaMccqeDemoBeforeSend("), context);
  await context.ngReconcileAylaMccqeDemoCrmLinks({ force: true });
  assert.equal(f.lead.ayla_experience_followups.length, 1);
  assert.equal(JSON.stringify(other.lead), untouched);
  assert.equal(db.message_logs.some((row) => row.lead_id === "other"), false);
});

function providers({ smtpReady = async () => {}, configReady = async () => {}, provider = "smtp" } = {}) {
  let calls = 0;
  const context = vm.createContext({ ...lifecycle, process: { env: {} }, WHATSAPP_GRAPH_VERSION: "v19.0",
    normalizePhoneForWhatsapp: (v) => v, ngClearWhatsAppProviderBlock: () => {},
    resolveWhatsAppCloudConfig: async () => { await configReady(); return { token: "local-test", phoneNumberId: "10101" }; },
    ngAylaEmailFromAddress: () => "AylaMed <support@example.test>", getEmailFromAddress: () => "NextGen <support@example.test>",
    ngResolveAylaEmailProvider: () => ({ provider }), ngResolveEmailProvider: () => ({ provider }), ngEmailTextToHtml: (v) => v,
    extractEmailAddress: (v) => v, extractEmailDisplayName: () => "Test",
    ngGetAylaSmtpTransporter: async () => { await smtpReady(); return { sendMail: async () => { calls++; return { accepted: ["doctor@example.test"] }; } }; },
    ngGetSmtpTransporter: async () => ({ sendMail: async () => { calls++; return {}; } }),
    axios: { post: async () => { calls++; return { data: { id: "accepted" }, status: 202 }; } },
  });
  vm.runInContext(section("async function sendWhatsAppCloudMessage(", "async function sendTelegramMessage(")
    + section("async function sendEmailMessage(", "function getBestRecipientForChannel("), context);
  return { context, calls: () => calls };
}

test("actual SMTP and WhatsApp provider edges recheck pilot after awaited configuration", async (t) => {
  scope(t, "pilot");
  const smtp = providers({ smtpReady: async () => { await Promise.resolve(); process.env[key] = "other"; } });
  await assert.rejects(smtp.context.sendEmailMessage({ to: "doctor@example.test", text: "demo", transport: "aylamed", privateMccqeLeadId: "pilot" }), /pilot scope/);
  assert.equal(smtp.calls(), 0);
  process.env[key] = "pilot";
  const whatsapp = providers({ configReady: async () => { await Promise.resolve(); process.env[key] = "other"; } });
  await assert.rejects(whatsapp.context.sendWhatsAppCloudMessage({ to: "18250000001", text: "demo", privateMccqeLeadId: "pilot" }), /pilot scope/);
  assert.equal(whatsapp.calls(), 0);
});

test("all email transports block nonpilot before provider, while ordinary NextGen ignores malformed pilot config", async (t) => {
  scope(t, "pilot");
  for (const provider of ["smtp", "resend", "sendgrid"]) {
    const h = providers({ provider });
    await assert.rejects(h.context.sendEmailMessage({ to: "doctor@example.test", text: "demo", transport: "aylamed", privateMccqeLeadId: "other" }), /pilot scope/);
    assert.equal(h.calls(), 0);
  }
  process.env[key] = " ";
  const h = providers();
  await h.context.sendEmailMessage({ to: "student@example.test", text: "NextGen update" });
  await h.context.sendWhatsAppCloudMessage({ to: "18250000001", text: "NextGen update", brandId: "brand_nextgen_usmle" });
  assert.equal(h.calls(), 2);
});
