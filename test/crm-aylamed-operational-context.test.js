import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildMccqeOperationalContext } from "../lib/crm-aylamed-operational-context.js";
import * as engine from "../lib/crm-ayla-conversation-engine.js";

function fixture() {
  const now = Date.now(), start = new Date(now - 3600000).toISOString(), expiry = new Date(now + 4 * 3600000).toISOString();
  const lead = { id: "lead-1", brand_id: "brand_aylamed", name: "Sam", email: "sam@example.com", exam_track: "mccqe", exam: "MCCQE", ayla_user_id: "user-1", meta_ad_id: "mccqe-ad" };
  const issuance = { id: "issuance-1", crm_lead_id: lead.id, brand_id: lead.brand_id, email: lead.email, user_id: lead.ayla_user_id,
    exam_track_id: "mccqe", enrollment_id: "demo-1", starts_at: start, expires_at: expiry,
    status: "issued", email_delivery_status: "accepted", email_delivery_at: new Date(now - 3590000).toISOString() };
  const aylaDb = { aylaUsers: { "user-1": { id: "user-1", email: lead.email, role: "student", status: "active" } },
    aylaCrmDemoIssuances: { "issuance-1": issuance }, aylaPayments: {},
    aylaEnrollments: { "demo-1": { id: "demo-1", user_id: "user-1", exam_track_id: "mccqe", type: "demo", is_demo: true,
      source: "crm_mccqe_demo", access_granted: true, status: "active", access_starts_at: start, access_expires_at: expiry } } };
  const crmDb = { leads: [structuredClone(lead)] };
  return { lead, crmDb, aylaDb, now, issuance };
}

test("operational facts use the exact saved lead/account/issuance/enrollment and clock, never CRM prose", () => {
  const f = fixture();
  f.lead.aylamed_demo = { status: "expired", expires_at: "2000-01-01" };
  const result = buildMccqeOperationalContext(f);
  assert.deepEqual(result, { brand_id: "brand_aylamed", exam: "MCCQE", paid: false,
    demo: { status: "active", email_delivery_status: "accepted", expires_at: f.issuance.expires_at } });
  assert.equal(buildMccqeOperationalContext({ ...f, now: Date.parse(f.issuance.expires_at) }).demo.status, "expired");
  assert.doesNotMatch(JSON.stringify(result), /sam@example|user-1|issuance-1|demo-1/);
});

test("missing or mismatched account identity stays completely unverified", () => {
  for (const change of [
    (f) => { f.lead.ayla_user_id = "wrong"; }, (f) => { f.lead.email = "another@example.com"; },
    (f) => { f.crmDb.leads[0].brand_id = "brand_nextgen_usmle"; },
    (f) => { f.crmDb.leads[0].exam_track = "usmle_step1"; },
    (f) => { f.crmDb.leads[0].brand_routing_review_required = true; },
    (f) => { f.aylaDb.aylaUsers["user-1"].email = "other@example.com"; },
    (f) => { f.aylaDb.aylaUsers["user-1"].status = "disabled"; },
    (f) => { f.crmDb.leads.push(structuredClone(f.crmDb.leads[0])); },
  ]) { const f = fixture(); change(f); assert.deepEqual(buildMccqeOperationalContext(f), {}); }
});

test("unknown trial scope/delivery/entitlement keeps independently verified account and paid facts", () => {
  for (const change of [
    (f) => { f.issuance.crm_lead_id = "another-lead"; },
    (f) => { f.issuance.exam_track_id = "usmle_step1"; },
    (f) => { f.issuance.email_delivery_status = "uncertain"; },
    (f) => { f.issuance.email_delivery_status = "reserved"; },
    (f) => { f.issuance.email_delivery_at = null; },
    (f) => { f.issuance.email_delivery_at = new Date(f.now + 3600000).toISOString(); },
    (f) => { f.aylaDb.aylaEnrollments["demo-1"].user_id = "other-user"; },
    (f) => { f.aylaDb.aylaEnrollments["demo-1"].access_granted = false; },
    (f) => { f.aylaDb.aylaEnrollments["demo-1"].access_expires_at = "2020-01-01T00:00:00Z"; },
    (f) => { f.aylaDb.aylaEnrollments["demo-1"].source = "admin_access_invitation"; },
    (f) => { f.aylaDb.aylaEnrollments["demo-1"].status = "expired"; },
    (f) => { f.aylaDb.aylaEnrollments = {}; },
    (f) => { f.aylaDb.aylaCrmDemoIssuances = {}; },
  ]) { const f = fixture(); change(f);
    f.aylaDb.aylaPayments.paid = { user_id: "user-1", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
    const facts = buildMccqeOperationalContext(f);
    assert.equal(facts.paid, true);
    assert.deepEqual(facts.demo, { status: "unknown", email_delivery_status: "unknown", expires_at: null });
  }
});

test("not-issued requires verified absence, while exact completed purchase suppresses the prior trial", () => {
  const f = fixture();
  f.aylaDb.aylaPayments.wrong = { user_id: "other", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
  assert.equal(buildMccqeOperationalContext(f).paid, false);
  f.aylaDb.aylaPayments.paid = { user_id: "user-1", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
  assert.equal(buildMccqeOperationalContext(f).paid, true);
  f.aylaDb.aylaCrmDemoIssuances = {};
  assert.equal(buildMccqeOperationalContext(f).paid, true);
  assert.equal(buildMccqeOperationalContext(f).demo.status, "unknown", "an unlinked legacy demo is not absence");
  f.aylaDb.aylaEnrollments = {};
  assert.equal(buildMccqeOperationalContext(f).demo.status, "not_issued");
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("async function ngAylaVerifiedMccqeConversationContext(");
const pipeline = server.slice(start, server.indexOf("\nfunction ngAylaRecordExperienceDelivery", start));

function pipelineHarness(f, drafts, onModel = () => {}) {
  const calls = [], contexts = { prompt: [], normalize: [], evaluate: [], repair: [] };
  let reads = 0;
  const neverLegacy = () => { throw new Error("AylaMed touched legacy NextGen context or operations"); };
  const spy = (name, key) => (...args) => {
    const value = key === "normalize" ? args[2]?.protectedActionContext : args[0]?.protectedActionContext;
    contexts[key].push(structuredClone(value || {}));
    return engine[name](...args);
  };
  const context = vm.createContext({
    ...engine, AYLAMED_BRAND_ID: "brand_aylamed", CRM_AYLA_REPLY_BUILD: "test", buildMccqeOperationalContext,
    aylaWriteQueue: Promise.resolve(), readCrmDb: async () => f.crmDb,
    readAylaDb: async () => { reads++; if (f.readError) throw new Error("store unavailable"); return f.aylaDb; },
    process: { env: { AYLAMED_AI_AUTO_SEND_ENABLED: "false" } }, safeArray: (value) => Array.isArray(value) ? value : [],
    ngMessageText: (message) => message.text || "", ngLatestInbound: (messages) => [...messages].reverse().find((row) => row.role !== "assistant"),
    ngIsOutboundMessage: (message) => message.role === "assistant", isAIConfigured: () => true,
    ngAylaFindActiveGoogleMeetAppointment: neverLegacy, ngAylaLeadGoogleMeetState: neverLegacy,
    ngAylaIsDirectGoogleMeetRequest: neverLegacy, ngAylaHardSalesRouter: neverLegacy,
    ngAylaShouldPresentInterestedLeadTour: neverLegacy, ngAylaEnsureOneTimeCountryOffer: neverLegacy,
    ngAylaLiveLmsSalesGrounding: neverLegacy, ngTrainingContextForFullAiAuto: neverLegacy,
    ngBuildAylaMediaGuidance: neverLegacy, reviewedLearningRules: neverLegacy, ngAylaOfficialExamGuidancePrompt: neverLegacy,
    ngAylaLiveSessionLinkViolations: neverLegacy, ngAylaRecordingLinkViolations: neverLegacy,
    learningGuidance: () => "", learningEvidence: () => ({}), uniqueList: (items) => [...new Set(items)],
    nowIso: () => new Date().toISOString(), safeJsonParseFromAI: JSON.parse,
    ngCleanAylaStudentReply: (value) => value, ngAylaApplyGreetingOnce: (value) => value,
    buildAylaConversationPrompt: spy("buildAylaConversationPrompt", "prompt"),
    normalizeAylaConversationDecision: spy("normalizeAylaConversationDecision", "normalize"),
    evaluateAylaConversationDecision: spy("evaluateAylaConversationDecision", "evaluate"),
    buildAylaConversationRepairPrompt: spy("buildAylaConversationRepairPrompt", "repair"),
    callOpenAIResponsesAPI: async (request) => { const index = calls.length; calls.push(request); onModel(f, index);
      const draft = drafts[index]; if (!draft) throw new Error("unexpected model request");
      return { text: JSON.stringify({ stage: "demo_experience", action: "reply_only", turn_goal: "specific_answer", ask_field: "none", ...draft }), model: "fake", usage: {} }; },
  });
  vm.runInContext(pipeline, context);
  return { calls, contexts, reads: () => reads, run: () => context.ngGenerateStudentAutoReply({ db: f.crmDb, lead: f.lead,
    messages: [{ id: "in-1", role: "student", text: "Can you confirm my MCCQE demo access?" }], allowOperationalActions: true }) };
}

test("actual generator passes authoritative facts through prompt, normalize and validation without legacy overrides", async () => {
  const f = fixture(), h = pipelineHarness(f, [{ reply: "I have emailed your demo invitation." }]);
  const result = await h.run();
  assert.equal(result.action, "reply_only"); assert.equal(result.feature_tour_requested, false);
  assert.equal(result.follow_up, null); assert.equal(result.media_asset_keys.length, 0);
  for (const key of ["prompt", "normalize", "evaluate"]) assert.ok(h.contexts[key].some((value) => value.demo?.status === "active"), key);
  assert.equal(h.reads(), 2);
  assert.doesNotMatch(h.calls[0].systemPrompt, /nextgenusmle|NextGen live|seven-day/);
});

test("actual repair receives the same verified facts and provider acceptance cannot become inbox delivery", async () => {
  const f = fixture(), h = pipelineHarness(f, [
    { reply: "Your demo email was delivered." }, { reply: "Your demo invitation was sent by email." },
  ]);
  await h.run();
  assert.equal(h.calls.length, 2);
  assert.equal(h.contexts.repair[0].demo.email_delivery_status, "accepted");
  assert.match(h.calls[1].userPrompt, /aylamed_unverified_email_receipt/);
});

test("authoritative purchase during generation refreshes normalization and repair into paid support", async () => {
  const f = fixture(), h = pipelineHarness(f, [
    { reply: "Your demo expires soon; purchase now.", payment_followup: { disposition: "payment_ready", evidence: "I will pay", requested_time: null } },
    { reply: "Your account is in paid access. I can help with the setup.", stage: "enrolled_support", turn_goal: "support" },
  ], (value, index) => { if (index === 0) value.aylaDb.aylaPayments.paid = { user_id: "user-1", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 }; });
  const result = await h.run();
  assert.equal(h.contexts.normalize[0].paid, true);
  assert.equal(h.contexts.repair[0].paid, true);
  assert.match(h.calls[1].systemPrompt, /"paid":true/);
  assert.equal(result.conversation_stage, "enrolled_support");
  assert.equal(result.payment_followup.disposition, "none");
});

test("purchase during generation forces repair of both a bare enrol question and otherwise harmless stale wording", async () => {
  for (const reply of ["Would you like to enrol?", "I can help with your preparation."]) {
    const f = fixture(), h = pipelineHarness(f, [{ reply }, { reply: "I can help with your account setup.", stage: "enrolled_support", turn_goal: "support" }],
      (value, index) => { if (index === 0) {
        value.aylaDb.aylaPayments.paid = { user_id: "user-1", exam_track_id: "mccqe", status: "completed", amount_cents: 4000 };
        value.aylaDb.aylaCrmDemoIssuances = {};
      } });
    const result = await h.run();
    assert.equal(h.calls.length, 2);
    assert.match(h.calls[1].userPrompt, /aylamed_paid_context_changed/);
    assert.equal(h.contexts.repair[0].paid, true);
    assert.equal(h.contexts.repair[0].demo.status, "unknown");
    assert.equal(result.conversation_stage, "enrolled_support");
  }
});

test("storage failure leaves actual prompt and repair unverified without inventing an unsent or sent demo", async () => {
  const f = fixture(); f.readError = true;
  const h = pipelineHarness(f, [{ reply: "I have emailed your demo invitation." }, { reply: "I can help verify your invitation status." }]);
  await h.run();
  assert.match(h.calls[0].systemPrompt, /"verified":false/);
  assert.deepEqual(h.contexts.repair[0], {});
  assert.match(h.calls[1].userPrompt, /aylamed_unverified_demo_delivery/);
});
