import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createMccqeDemoOutboundGuard, mccqeDemoSendEligibility, mccqeDemoResource } from "../lib/crm-aylamed-demo-lifecycle.js";
import { aylaOutboundContentSafety } from "../lib/crm-brand-routing.js";
import { buildMccqeOperationalContext, validateMccqeAutomaticOutbound } from "../lib/crm-aylamed-operational-context.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const source = server.slice(server.indexOf("async function sendCrmMessage({"), server.indexOf("\nfunction normalizeAutomationEnrollment", server.indexOf("async function sendCrmMessage({")));

function harness() {
  const now = Date.now(), starts = new Date(now - 6 * 3600000).toISOString(), expires = new Date(now - 3600000).toISOString();
  const issuance = { id: "issuance", crm_lead_id: "lead", brand_id: "brand_aylamed", user_id: "user", enrollment_id: "enrollment", email: "doctor@example.com",
    exam_track_id: "mccqe", starts_at: starts, expires_at: expires, login_url: "https://mccqe.aylamedapp.com/login", email_delivery_status: "accepted", status: "issued", email_delivery_at: starts };
  const store = { aylaCrmDemoIssuances: { issuance }, aylaUsers: { user: { id: "user", email: issuance.email, status: "active" } },
    aylaEnrollments: { enrollment: { id: "enrollment", user_id: "user", exam_track_id: "mccqe", source: "crm_mccqe_demo", type: "demo", is_demo: true,
      access_granted: true, access_starts_at: starts, access_expires_at: expires } }, aylaPayments: {} };
  const item = { ...mccqeDemoResource(issuance), id: "checkin", resource_id: "issuance", status: "pending", reservation_id: "reservation" };
  const lead = { id: "lead", brand_id: "brand_aylamed", exam_track: "mccqe", email: issuance.email, ayla_user_id: "user", phone: "+18250000000", ayla_experience_followups: [item] };
  const db = { leads: [lead], logs: [] };
  let calls = 0;
  const guard = createMccqeDemoOutboundGuard({ verify: ({ context, item: current }) => mccqeDemoSendEligibility({ db: store, lead: context.lead, item: current, now }) });
  const context = vm.createContext({
    process: { env: { AYLAMED_AI_AUTO_SEND_ENABLED: "false" } }, AYLAMED_BRAND_ID: "brand_aylamed", ngMccqeDemoOutboundGuard: guard,
    getLeadByAnyId: (value, id) => value.leads.find((row) => row.id === id), getMessageTemplateByKey: () => null,
    ngAylaOutboundCommandMetadata: () => ({}), resolveCrmChannel: ({ requestedChannel }) => requestedChannel,
    renderTemplateString: (value) => value, getBestRecipientForChannel: ({ to, lead: row }) => to || row.phone,
    getIntegrationByPlatform: () => ({ id: "shared", platform: "whatsapp", brand_id: "brand_aylamed" }),
    getWhatsAppTemplateName: () => "", getWhatsAppLanguageCode: () => "", buildWhatsAppTemplateComponents: () => [],
    normalizeCrmString: (value) => String(value || "").trim(), normalizeCrmLower: (value) => String(value || "").toLowerCase(),
    ngCrmOutboundIsAutomated: ({ metadata }) => /auto|experience|scheduler/.test(metadata?.source || ""), aylaOutboundContentSafety, integrationSupportsBrand: () => true,
    ngAylaVerifiedMccqeConversationContext: async (currentLead) => buildMccqeOperationalContext({ crmDb: db, aylaDb: store, lead: currentLead, now }),
    validateMccqeAutomaticOutbound, ngLeadConversationMessages: () => [], safeArray: (value) => Array.isArray(value) ? value : [],
    ngWhatsAppProviderBlockStatus: () => ({ blocked: false }), ngFindRecentDuplicateDelivery: () => null,
    ngStartDeliveryLock: () => ({ delivery_dedupe_key: "dedupe" }), ngFinishDeliveryLock: () => {},
    sendWhatsAppCloudMessage: async () => { calls++; return { messages: [{ id: "provider-message" }] }; },
    createMessageLog: (value, log) => { const result = { id: `log-${value.logs.length}`, ...log }; value.logs.push(result); return result; },
    nowIso: () => new Date(now).toISOString(), appendSocialConversation: () => {}, ngUpdateLeadWhatsAppSendStatus: () => {},
    extractProviderError: (error) => error.message,
    classifyWhatsAppProviderFailure: () => ({ category: "blocked", whatsapp_status: "blocked", retryable: false, suppress_until_fixed: false }),
  });
  vm.runInContext(source, context);
  const text = "Did you have a chance to explore your five-hour AylaMed MCCQE demo?";
  const issue = () => guard.issue({ lead, item, text, to: lead.phone });
  const send = (patch = {}) => context.sendCrmMessage({ db, leadId: lead.id, brandId: lead.brand_id, channel: "whatsapp", text,
    metadata: { source: "backend_experience_checkin" }, ...patch });
  return { store, db, lead, item, issue, send, calls: () => calls, enableBroadForTest: () => { context.process.env.AYLAMED_AI_AUTO_SEND_ENABLED = "true"; } };
}

test("actual central sender refuses JSON/metadata bypass and keeps generic Ayla AI off", async () => {
  const h = harness();
  const metadata = await h.send({ metadata: { source: "backend_experience_checkin", aylamed_demo: true, issuance_id: "issuance", authorized: true } });
  assert.equal(metadata.success, false);
  assert.match(metadata.error, /automatic outbound is disabled/);
  const forged = await h.send({ aylaDemoAuthorization: JSON.parse('{"issuance_id":"issuance"}') });
  assert.equal(forged.success, false);
  assert.equal(h.calls(), 0);
});

test("actual central sender permits only one reserved, verified demo capability and rejects replay", async () => {
  const h = harness(), authorization = h.issue();
  assert.equal((await h.send({ aylaDemoAuthorization: authorization })).success, true);
  assert.equal((await h.send({ aylaDemoAuthorization: authorization })).success, false);
  assert.equal(h.calls(), 1);
  assert.equal((await h.send()).success, false);
});

test("actual central sender rejects unrelated lead, changed issuance and purchase after authorization", async () => {
  for (const change of [
    (h) => { h.lead.id = "another-lead"; },
    (h) => { h.item.issuance_id = "another-issuance"; },
    (h) => { h.store.aylaPayments.paid = { id: "paid", user_id: "user", exam_track_id: "mccqe", amount_cents: 4000, payment_status: "completed" }; },
  ]) {
    const h = harness(), authorization = h.issue();
    change(h);
    assert.equal((await h.send({ aylaDemoAuthorization: authorization })).success, false);
    assert.equal(h.calls(), 0);
  }
});

test("actual central sender rechecks a purchase after generation/delay and retains it with a malformed old trial", async () => {
  const h = harness(); h.enableBroadForTest();
  const draftedBeforePurchase = "Would you like to enrol?";
  h.store.aylaPayments.paid = { id: "paid", user_id: "user", exam_track_id: "mccqe", amount_cents: 4000, payment_status: "completed" };
  h.store.aylaCrmDemoIssuances.issuance.enrollment_id = "missing-old-trial";
  const result = await h.send({ text: draftedBeforePurchase });
  assert.equal(result.success, false);
  assert.match(result.hint, /aylamed_paid_student_sales_pitch/);
  assert.equal(h.calls(), 0);
});

test("actual central sender rejects stale demo claims and completely unknown account context before provider", async () => {
  for (const text of ["I have emailed your demo invitation.", "Your demo was not issued."]) {
    const h = harness(); h.enableBroadForTest();
    h.store.aylaCrmDemoIssuances.issuance.email_delivery_status = "uncertain";
    const result = await h.send({ text });
    assert.equal(result.success, false);
    assert.match(result.hint, /aylamed_unverified_demo_/);
    assert.equal(h.calls(), 0);
  }
  const h = harness(); h.enableBroadForTest(); delete h.lead.ayla_user_id;
  const result = await h.send({ text: "I can help with your account." });
  assert.equal(result.success, false);
  assert.equal(result.hint, "aylamed_outbound_identity_unverified");
  assert.equal(h.calls(), 0);
});

test("actual central final guard preserves manual Ayla messages and existing NextGen automatic sends", async () => {
  const manual = harness(); delete manual.lead.ayla_user_id;
  assert.equal((await manual.send({ metadata: { source: "crm_messages_send" }, text: "I can help with your account." })).success, true);
  assert.equal(manual.calls(), 1);
  const legacy = harness(); legacy.lead.brand_id = "brand_nextgen_usmle"; delete legacy.lead.ayla_user_id;
  assert.equal((await legacy.send({ text: "Your NextGen preparation plan is ready." })).success, true);
  assert.equal(legacy.calls(), 1);
});
