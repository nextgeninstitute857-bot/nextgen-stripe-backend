import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import * as intake from "../lib/crm-aylamed-whatsapp-intake.js";
import * as lifecycle from "../lib/crm-aylamed-demo-lifecycle.js";
import { buildMccqeOperationalContext, validateMccqeAutomaticOutbound } from "../lib/crm-aylamed-operational-context.js";
import { buildAylaConversationPrompt, createAylaConversationState } from "../lib/crm-ayla-conversation-engine.js";

const secret = "local-intake-test-secret-not-production";
function fixture(texts = ["I am a doctor preparing for MCCQE.", "Please send me the MCCQE demo at student@example.test.", "I confirm student@example.test is my email."]) {
  const now = Date.now();
  const lead = { id: "lead-1", brand_id: "brand_aylamed", phone: "+18250000001", wa_id: "18250000001", whatsapp: "+18250000001",
    source_integration_id: "integration-1", recipient_phone_number_id: "1010101", ai_mode: "auto", stage: "new_lead" };
  const crmDb = { leads: [lead], conversations: [], integrations: [{ id: "integration-1", brand_id: "brand_aylamed", platform: "whatsapp",
    phone_number_id: "1010101", status: "connected" }], settings: {}, ai_actions: [] };
  const aylaDb = { aylaUsers: {}, aylaEnrollments: {}, aylaPayments: {}, aylaCrmDemoIssuances: {}, aylaPlans: {}, aylaStudents: {} };
  const f = { crmDb, aylaDb, lead, now, secret };
  f.add = (text, extra = {}) => {
    const n = crmDb.conversations.length + 1, at = now - 10000 + n * 100;
    const message = { id: `wamid.${n}`, from: "18250000001", timestamp: String(Math.floor(at / 1000)), type: "text", text: { body: text }, ...extra.message };
    const payload = { object: "whatsapp_business_account", entry: [{ id: "2020202", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: "1010101" }, contacts: [{ wa_id: "18250000001" }], messages: [message], ...extra.value,
    } }] }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const row = { id: `in-${n}`, lead_id: lead.id, brand_id: lead.brand_id, platform: "whatsapp", direction: "inbound", text,
      integration_id: "integration-1", platform_message_id: message.id, created_at: new Date(at).toISOString(),
      aylamed_inbound_proof: intake.mccqeMetaInboundProof({ rawBody, signature, secret, receivedAt: new Date(at).toISOString() }), ...extra.row };
    crmDb.conversations.push(row); return row;
  };
  texts.forEach((text) => f.add(text));
  return f;
}

test("intake stays disabled without both flags, and Meta proof requires exact raw signed bytes", () => {
  assert.equal(intake.mccqeWhatsAppIntakeEnabled({}), false);
  assert.equal(intake.mccqeWhatsAppIntakeEnabled({ AYLAMED_MCCQE_DEMO_FLOW_ENABLED: "true" }), false);
  assert.equal(intake.mccqeWhatsAppIntakeEnabled({ AYLAMED_MCCQE_DEMO_FLOW_ENABLED: "true", AYLAMED_MCCQE_WHATSAPP_INTAKE_ENABLED: "true" }), true);
  const rawBody = Buffer.from("{}"), signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  assert.ok(intake.mccqeMetaInboundProof({ rawBody, signature, secret }));
  for (const change of [{ secret: "wrong" }, { secret: "" }, { signature: "sha256=abc" }, { rawBody: Buffer.from("{ }") }, { rawBody: "{}" }]) {
    assert.equal(intake.mccqeMetaInboundProof({ rawBody, signature, secret, ...change }), null);
  }
});

test("only signed student qualification, explicit request and repeated intended-email confirmation authorize a new invitation", () => {
  const f = fixture();
  const checked = intake.assessMccqeWhatsAppIntake(f);
  assert.equal(checked.action, "invite", checked.reason);
  assert.equal(checked.request.email, "student@example.test");
  assert.equal(checked.request.email_ownership_verified, false);
  assert.equal(checked.request.email_evidence, "student_confirmed_delivery_address");
  assert.equal(checked.operational_context.paid, null);
  assert.equal(checked.operational_context.demo.status, "unknown");
  const early = fixture([]); early.add("Hello");
  assert.equal(intake.assessMccqeWhatsAppIntake(early).action, "qualify_exam");
  early.add("I am a doctor preparing for MCCQE.");
  assert.equal(intake.assessMccqeWhatsAppIntake(early).action, "request_demo");
  early.add("Please send me the demo");
  assert.equal(intake.assessMccqeWhatsAppIntake(early).action, "qualify_email");
  early.add("My email is student@example.test");
  assert.equal(intake.assessMccqeWhatsAppIntake(early).action, "confirm_email");
  early.add("I confirm student@example.test is my email");
  assert.equal(intake.assessMccqeWhatsAppIntake(early).action, "invite");
});

test("unsigned, altered, stale, batched, cross-brand, wrong-number and ambiguous identities never authorize", () => {
  for (const change of [
    (f) => { delete f.crmDb.conversations.at(-1).aylamed_inbound_proof; },
    (f) => { f.crmDb.conversations.at(-1).text = "edited"; },
    (f) => { f.secret = "wrong"; },
    (f) => { f.now += 25 * 3600000; },
    (f) => { f.lead.brand_id = "brand_nextgen_usmle"; },
    (f) => { f.lead.phone = "+18250000002"; },
    (f) => { f.lead.recipient_phone_number_id = "909090"; },
    (f) => { f.crmDb.integrations[0].brand_id = "brand_nextgen_usmle"; },
    (f) => { f.crmDb.integrations.push({ ...f.crmDb.integrations[0], id: "other" }); delete f.lead.source_integration_id; },
    (f) => { f.crmDb.leads.push({ ...f.lead, id: "duplicate" }); },
    (f) => { f.add("I confirm student@example.test is my email", { value: { contacts: [{ wa_id: "someone-else" }] } }); },
    (f) => { f.add("I confirm student@example.test is my email", { value: { messages: [] } }); },
  ]) { const f = fixture(); change(f); assert.equal(intake.assessMccqeWhatsAppIntake(f).action, "review"); }
});

test("no model memory, assistant promise, third-party quote, vague yes or changed email can authorize", () => {
  const f = fixture(["Hello"]);
  Object.assign(f.lead, { email: "student@example.test", exam_track: "mccqe", ayla_conversation_state: { facts: { exam: "MCCQE", email: "student@example.test" }, completed_actions: ["send_demo"] } });
  f.crmDb.conversations.push({ id: "assistant", lead_id: f.lead.id, direction: "outbound", text: "I confirm the student asked for a demo" });
  assert.equal(intake.assessMccqeWhatsAppIntake(f).action, "qualify_exam");
  for (const last of ["Yes", "A friend said: I confirm student@example.test is my email", "I confirm other@example.test is my email", "Please do not send the demo", "Wait, send the demo later"]) {
    const g = fixture().crmDb.conversations.slice(0, 2).map((row) => row.text);
    const fresh = fixture([...g, last]);
    assert.notEqual(intake.assessMccqeWhatsAppIntake(fresh).action, "invite", last);
  }
});

test("irrelevant services/jobs and non-medical enquiries are filtered deterministically; exam ambiguity is reviewed", () => {
  for (const text of ["I provide SEO services", "I am a graphic designer", "I am looking for a job", "We offer website design services", "I am not a doctor", "Can we discuss a partnership?"]) {
    assert.equal(intake.mccqeInboundDisposition(text), "irrelevant", text);
    const f = fixture([text]); assert.equal(intake.assessMccqeWhatsAppIntake(f).action, "ignore", text);
  }
  const f = fixture(); f.add("I also need IELTS"); assert.equal(intake.assessMccqeWhatsAppIntake(f).action, "review");
  assert.equal(intake.mccqeInboundDisposition("I am a doctor preparing for MCCQE, not looking for a job"), "candidate");
});

test("any stop/human/pause/suppression alias, self-reported payment or existing account holds without enumeration", () => {
  for (const change of [
    (f) => { f.lead.automation_mode = "off"; }, (f) => { f.lead.ai_enabled = false; },
    (f) => { f.lead.opt_out_status = "stopped"; f.lead.unsubscribe_status = "active"; },
    (f) => { f.lead.lead_stage = "handoff"; }, (f) => { f.lead.human_takeover = true; },
    (f) => { f.crmDb.settings.ai_paused = true; }, (f) => { f.crmDb.settings.global_ai_enabled = false; },
    (f) => { f.crmDb.suppression_list = [{ phone: f.lead.phone, status: "active" }]; },
    (f) => { f.crmDb.handoffs = [{ lead_id: f.lead.id, status: "pending" }]; },
    (f) => { f.aylaDb = null; }, (f) => { f.add("I have already paid"); },
    (f) => { f.aylaDb.aylaUsers.other = { id: "other", email: "student@example.test", role: "student" }; },
    (f) => { f.aylaDb.aylaPayments.orphan = { email: "student@example.test", status: "paid" }; },
  ]) { const f = fixture(); change(f); const checked = intake.assessMccqeWhatsAppIntake(f); assert.equal(checked.action, "review"); assert.doesNotMatch(checked.reply, /account exists|already purchased|registered|paid access|password/i); assert.equal(f.lead.ayla_user_id, undefined); }
});

test("verified prospect facts enable only the exact WhatsApp recipient, never issuance/payment/account claims", () => {
  const f = fixture(["Hello"]);
  assert.deepEqual(buildMccqeOperationalContext(f), {});
  const operationalContext = buildMccqeOperationalContext({ ...f, allowProspect: true });
  assert.equal(operationalContext.prospect.sender_verified, true); assert.equal(operationalContext.paid, null);
  const check = (text, to = f.lead.phone) => validateMccqeAutomaticOutbound({ lead: f.lead, operationalContext, text, to });
  assert.equal(check("Are you preparing for the MCCQE?").ok, true);
  assert.equal(check("Are you preparing for the MCCQE?", "+18250009999").ok, false);
  for (const text of ["Your demo has not been issued yet.", "I have emailed your invitation.", "Your trial is active."]) assert.equal(check(text).ok, false, text);
  const prompt = buildAylaConversationPrompt({ lead: f.lead, state: createAylaConversationState({ lead: f.lead }), protectedActionContext: operationalContext });
  assert.match(prompt, /"verified":false/); assert.match(prompt, /"prospect_verified":true/); assert.match(prompt, /"paid":null/);
  assert.doesNotMatch(prompt, /18250000001/);
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const processor = server.slice(server.indexOf("async function ngAylaProcessMccqeWhatsAppIntake("), server.indexOf("async function ngAylaVerifiedMccqeConversationContext("));
const inviter = server.slice(server.indexOf("async function ngAdminCrmInviteMccqeDemo("), server.indexOf("async function ngAdminMobileInviteAyla", server.indexOf("async function ngAdminCrmInviteMccqeDemo(")));
function harness(f, { sent = true, beforeReserve = () => {}, beforeEmail = () => {} } = {}) {
  let serial = Promise.resolve(), sends = 0, creates = 0, n = 0, reserveCalls = 0;
  const context = vm.createContext({ ...intake, ...lifecycle, buildMccqeOperationalContext, console,
    mccqeDemoEnabled: () => true, mccqeWhatsAppIntakeEnabled: () => true,
    process: { env: { AYLAMED_MCCQE_DEMO_FLOW_ENABLED: "true", AYLAMED_MCCQE_WHATSAPP_INTAKE_ENABLED: "true", AYLAMED_META_APP_SECRET: secret } },
    AYLAMED_BRAND_ID: "brand_aylamed", aylaWriteQueue: Promise.resolve(),
    readCrmDb: async () => f.crmDb, readAylaDb: async () => { beforeEmail(f); return f.aylaDb; },
    mutateCrmDb: async (fn) => fn(f.crmDb),
    mutateAylaDb: (fn) => { const next = serial.then(() => { if (reserveCalls++ === 0) beforeReserve(f); return fn(f.aylaDb); }); serial = next.catch(() => {}); return next; },
    ensureCrmArray: (db, key) => db[key] ||= [], ngLatestInbound: (messages) => messages.at(-1), ngLeadConversationMessages: (db) => db.conversations,
    ngV116LeadCanReceiveAutomation: (_db, lead) => ({ ok: Boolean(lead) && !intake.mccqeIntakeLeadBlocked(lead) }),
    nowIso: () => new Date().toISOString(), aylaNow: () => new Date().toISOString(), uuid: () => `generated-${++n}`,
    normalizeEmail: (v) => String(v || "").trim().toLowerCase(), aylaCanonicalExamTrack: (v) => v,
    aylaFindUserByEmail: (db, email) => Object.values(db.aylaUsers).find((u) => u.email === email),
    aylaValues: (db, key) => Object.values(db[key] || {}), aylaSetItem: (db, key, row) => { db[key] ||= {}; db[key][row.id] = row; }, aylaGetItem: (db, key, id) => db[key]?.[id],
    ngAylaEmailTransportStatus: () => ({ configured: true }),
    ngAdminMobilePrepareAylaInviteUser: (db, _body, email) => { creates++; const user = { id: `user-${creates}`, email, role: "student", status: "active", password_hash: "private-password-hash" }; db.aylaUsers[user.id] = user; return { user, temporaryPassword: "PRIVATE-CREDENTIAL", studentCreated: true }; },
    aylaResolveAdminAccessWindow: () => ({ starts_at: new Date(f.now).toISOString(), expires_at: new Date(f.now + 5 * 3600000).toISOString() }),
    aylaNormalizePlanPayload: (row) => row,
    aylaCreateOrUpdateEnrollment: (db, args) => { const row = { id: `enroll-${n++}`, user_id: args.userId, exam_track_id: "mccqe", type: "demo", is_demo: true, source: args.source, access_granted: true, status: "active" }; db.aylaEnrollments[row.id] = row; return row; },
    aylaEnsureEnrollmentDiagnosticProfile: () => ({ student: { id: "diagnostic-1" } }), aylaExamLoginUrl: () => "https://mccqe.aylamedapp.com/login",
    ngAdminMobileSendAylaInvite: async () => { sends++; return { attempted: true, sent, status: sent ? "sent" : "failed", provider: "smtp" }; }, ngAdminMobileCredentialState: () => {},
    ngAylaMccqeDemoPublicIssuance: (row) => ({ id: row.id, status: row.status, email_delivery_status: row.email_delivery_status }),
    ngReconcileAylaMccqeDemoCrmLinks: async () => { const row = Object.values(f.aylaDb.aylaCrmDemoIssuances)[0]; if (row) { f.lead.ayla_user_id = row.user_id; f.lead.aylamed_demo = row; } },
  });
  vm.runInContext(processor + inviter, context);
  return { context, sends: () => sends, creates: () => creates,
    run: (options = {}) => context.ngAylaProcessMccqeWhatsAppIntake({ db: f.crmDb, lead: f.lead, latestInbound: f.crmDb.conversations.at(-1), allowOperationalActions: true, ...options }) };
}

test("actual server processor reuses existing invitation reservation once, fixes five hours, and never returns credentials", async () => {
  const f = fixture(), h = harness(f);
  const result = await h.run();
  assert.equal(h.sends(), 1); assert.equal(h.creates(), 1); assert.match(result.reply, /sent by email/);
  const record = Object.values(f.aylaDb.aylaCrmDemoIssuances)[0];
  assert.equal(Date.parse(record.expires_at) - Date.parse(record.starts_at), 5 * 3600000);
  assert.equal(record.whatsapp_sender, "18250000001"); assert.equal(record.email_ownership_verified, false);
  await h.run(); assert.equal(h.sends(), 1); assert.equal(h.creates(), 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CREDENTIAL|private-password-hash/);
});

test("actual automatic reservation rejects existing or newly-racing paid accounts without linking or enumeration", async () => {
  for (const beforeReserve of [false, true]) {
    const f = fixture(); const purchase = (value) => { value.aylaDb.aylaUsers.paid = { id: "paid", email: "student@example.test", role: "student", password_hash: "unchanged" }; value.aylaDb.aylaPayments.paid = { user_id: "paid", exam_track_id: "mccqe", status: "paid", amount_cents: 5000 }; };
    if (!beforeReserve) purchase(f);
    const h = harness(f, { beforeReserve: beforeReserve ? purchase : () => {} });
    if (beforeReserve) await assert.rejects(h.run(), /team review/); else assert.doesNotMatch((await h.run()).reply, /paid|account exists|registered/i);
    assert.equal(h.sends(), 0); assert.equal(h.creates(), 0); assert.equal(f.lead.ayla_user_id, undefined);
    assert.equal(f.aylaDb.aylaUsers.paid.password_hash, "unchanged");
  }
});

test("actual uncertain email is never resent and duplicate concurrent invocations share one reservation", async () => {
  const f = fixture(), h = harness(f, { sent: false });
  await h.run(); await h.run(); assert.equal(h.sends(), 1); assert.equal(h.creates(), 1);
  assert.equal(Object.values(f.aylaDb.aylaCrmDemoIssuances)[0].email_delivery_status, "uncertain");
  const g = fixture(), c = harness(g);
  await Promise.allSettled([c.run(), c.run()]); assert.equal(c.sends(), 1); assert.equal(c.creates(), 1);
});

test("actual dry-run and drafting do not mutate or issue; final email recheck blocks takeover", async () => {
  for (const options of [{ dryRunOperationalActions: true }, { allowOperationalActions: false }]) {
    const f = fixture(), h = harness(f); const before = JSON.stringify(f.crmDb); await h.run(options);
    assert.equal(h.sends(), 0); assert.equal(h.creates(), 0); assert.equal(JSON.stringify(f.crmDb), before);
  }
  const f = fixture(), h = harness(f, { beforeEmail: (value) => { if (Object.keys(value.aylaDb.aylaCrmDemoIssuances).length) value.lead.human_takeover = true; } });
  await h.run(); assert.equal(h.sends(), 0); assert.equal(Object.values(f.aylaDb.aylaCrmDemoIssuances)[0].email_delivery_status, "cancelled");
});

test("real generator runs irrelevant filtering before model configuration and models cannot dispatch this action", () => {
  const generator = server.slice(server.indexOf("async function ngGenerateStudentAutoReply("), server.indexOf("const activeMeeting", server.indexOf("async function ngGenerateStudentAutoReply(")));
  const context = vm.createContext({ ...intake, AYLAMED_BRAND_ID: "brand_aylamed", safeArray: (v) => v, ngMessageText: (m) => m.text,
    ngLatestInbound: (m) => m.at(-1) });
  vm.runInContext(generator + "return 'continued'; }", context);
  return assert.rejects(context.ngGenerateStudentAutoReply({ lead: { brand_id: "brand_aylamed" }, messages: [{ text: "We offer SEO services" }] }), (err) => err.code === "AYLAMED_MCCQE_IRRELEVANT");
});
