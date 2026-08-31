import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

// Execute the actual server functions without starting HTTP, timers, databases
// or providers. Every send below is an in-memory fake.
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
function between(start, end) {
  const a = server.indexOf(start);
  const b = server.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return server.slice(a, b);
}
const source = [
  between("function ngLeadEligibleForFallbackWelcome", "function ngGetAssistantTimeZone"),
  between("async function ngSendAutoFirstMessageForLead", "const ngPostImportFirstMessageJobKeys"),
  between("function ngAylaDeliveryActuallySent", "function ngAylaMarkProcessedOnlyIfDelivered"),
  between("function ngLeadConversationMessages", "function ngHasOutboundAfterInbound"),
  between("function buildWhatsAppTemplateComponents", "function sanitizeWhatsAppTemplateComponents"),
].join("\n");
const clean = (v) => String(v || "").trim();
const array = (db, key) => Array.isArray(db[key]) ? db[key] : (db[key] = []);
const makeLead = (id = "one", overrides = {}) => ({
  id, name: "Test Student", exam: "USMLE Step 1", phone: "+15555550123",
  brand_id: "nextgen", stage: "new_lead", ai_mode: "auto", queue_first_message: true, ...overrides,
});
function harness(send = async () => ({ success: true, status: "sent" })) {
  const sends = [];
  const deps = {
    process: { env: {} },
    normalizeCrmLeadStageValue: clean, normalizeCrmLower: clean, normalizeCrmLeadAiMode: clean,
    ngLeadExplicitlyQueuedForFirstMessage: (l) => l.queue_first_message,
    ngLeadLooksLikeMetaCampaignLead: (l) => Boolean(l.campaign_id),
    leadHasRecipientForChannel: (l) => Boolean(l.phone),
    ngLeadHasOutboundTemplate: () => false,
    getStableLeadId: (l) => l.id || l.lead_id,
    ngAffArray: array, ensureCrmArray: array, safeArray: (a) => Array.isArray(a) ? a : [],
    safeTemplateValue: clean, looksLikePhoneOnly: (s) => /^[+\d\s()-]+$/.test(s),
    ngResolveAutoFirstMessageTemplateKey: () => "nextgen_warm_welcome",
    getMessageTemplateByKey: () => null,
    ngGetOfficialWhatsAppTemplateNameForKey: (k) => k,
    ngAutoFirstVirtualTemplate: (key) => ({ key, body: "Hi {{name}}, your {{exam}} programme.", variables: ["name", "exam"] }),
    resolveWhatsAppTemplateVariableOrder: ({ template }) => template.variables,
    getLeadVariableValue: (key, lead, vars) => vars[key] || lead[key],
    getWhatsAppTemplateName: ({ template }) => template.key,
    getWhatsAppTemplateLookupKeys: ({ template }) => [template.key],
    REQUIRED_WHATSAPP_LINK_VARIABLES: new Set(),
    REQUIRED_NEXTGEN_WHATSAPP_TEMPLATE_VARIABLES: new Set(["name", "exam"]),
    WHATSAPP_TEMPLATE_NAME_ALIASES: {},
    ngAylaOwnerCommandBlocksBulkSend: (db) => ({ blocked: db.ownerBlocked, reason: "owner_paused" }),
    ngBuildAylaCommandContext: () => "",
    ngAutoFirstFallbackTextForTemplate: () => "Welcome",
    getBestRecipientForChannel: ({ lead }) => lead.phone,
    ngLiveSessionTimingStateNow: () => ({ phase: "no_live" }),
    ngIsSundayNoLiveSessionDay: () => false,
    normalizeWhatsAppLanguageCode: clean,
    normalizeTemplateLookupKey: clean,
    nowIso: () => new Date().toISOString(), todayKey: () => new Date().toISOString().slice(0, 10),
    sendCrmMessage: async (args) => { sends.push(args); return send(args); },
  };
  const fns = new Function(...Object.keys(deps), `${source}; return { ngCanSendAutoFirstMessage, ngSendAutoFirstMessageForLead, ngRunDueAutoFirstMessages, ngFirstMessageConversationStarted };`)(...Object.values(deps));
  return { ...fns, sends };
}

test("missing exam or name is blocked in both live and dry-run; no exam is invented", async () => {
  for (const changes of [{ exam: "" }, { name: "" }]) {
    const h = harness();
    const lead = makeLead("incomplete", changes);
    const db = { leads: [lead] };
    const before = structuredClone(lead);
    for (const dryRun of [true, false]) {
      const result = await h.ngSendAutoFirstMessageForLead({ db, lead, dryRun });
      assert.equal(result.sent, false);
      assert.equal(result.reason, "first_message_template_not_ready");
    }
    assert.equal(h.sends.length, 0);
    assert.deepEqual(lead, before);
  }
});

test("an incomplete oldest lead does not starve a ready lead in a one-item batch", async () => {
  const h = harness();
  const db = { leads: [makeLead("old", { exam: "", created_at: "2026-08-01" }), makeLead("ready", { created_at: "2026-08-02" })] };
  const results = await h.ngRunDueAutoFirstMessages({ db, bulkSettings: { first_message_batch_size: 1 } });
  assert.equal(results.length, 1);
  assert.equal(results[0].lead_id, "ready");
  assert.equal(results[0].sent, true);
  assert.equal(h.sends.length, 1);
  assert.equal(db.leads[0].first_message_sent_at, undefined);
});

test("an existing WhatsApp inbound is left to the conversational responder", async () => {
  for (const collection of ["message_logs", "inbound_messages", "conversations"]) {
    const h = harness();
    const lead = makeLead();
    const db = { leads: [lead], [collection]: [{ lead_id: lead.id, direction: "inbound", channel: "whatsapp", text: "Hi" }] };
    const result = await h.ngSendAutoFirstMessageForLead({ db, lead });
    assert.equal(result.reason, "first_message_conversation_already_started");
    assert.equal(h.sends.length, 0);
  }
});

test("a WhatsApp ad lead uses the organised conversation flow instead of a welcome template", async () => {
  const h = harness();
  const lead = makeLead("open-window", {
    queue_first_message: false,
    campaign_id: "meta-click-to-whatsapp",
    source: "meta whatsapp ad",
  });
  const result = await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead] }, lead });
  assert.equal(result.reason, "welcome_fallback_not_explicitly_queued");
  assert.equal(h.sends.length, 0);
});

test("an explicitly queued lead-form contact may use the fallback welcome doorway", async () => {
  const h = harness();
  const lead = makeLead("lead-form", {
    queue_first_message: false,
    campaign_id: "meta-lead-form",
    source: "meta lead_form",
    first_message_queue_status: "queued",
  });
  const result = await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead] }, lead });
  assert.equal(result.sent, true);
  assert.equal(h.sends.length, 1);
});

test("accepted conversational replies prevent duplicate welcomes", () => {
  const h = harness();
  const lead = makeLead();
  for (const status of ["accepted", "queued", "sent", "delivered", "read"]) {
    const db = { leads: [lead], outbound_messages: [{ lead_id: lead.id, direction: "outbound", channel: "whatsapp", text: "Hi, how can I help?", status }] };
    assert.equal(h.ngCanSendAutoFirstMessage(db, lead).reason, "first_message_conversation_already_started", status);
  }
});

test("failed drafts, other channels and another lead's messages do not fake contact", () => {
  const h = harness();
  const lead = makeLead();
  for (const message of [
    ...["failed", "blocked", "suppressed", "error", "skipped", "draft", "pending_approval"].map(status => ({ status, sent_at: "2026-08-01" })),
    { channel: "email", status: "sent" }, { lead_id: "other", status: "sent", to: lead.phone },
  ]) {
    const db = { leads: [lead], message_logs: [{ lead_id: lead.id, direction: "outbound", channel: "whatsapp", text: "Hello", ...message }] };
    assert.equal(h.ngCanSendAutoFirstMessage(db, lead).ok, true, JSON.stringify(message));
  }
});

test("skipped, duplicate or failed successes never mark first message sent", async () => {
  for (const result of [{ success: true, skipped: true }, { success: true, duplicate_blocked: true }, { success: true, status: "failed" }, { success: false }]) {
    const h = harness(async () => result);
    const lead = makeLead();
    const actual = await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead] }, lead });
    assert.equal(actual.sent, false);
    assert.equal(lead.first_message_sent_at, undefined);
    assert.equal(lead.stage, "new_lead");
  }
});

test("a provider exception is isolated, subsequent leads run, and normal cooldown is preserved", async () => {
  const h = harness(async ({ leadId }) => {
    if (leadId === "bad") throw new Error("Provider unavailable");
    return { success: true, status: "sent" };
  });
  const db = { leads: [makeLead("bad"), makeLead("good")] };
  const results = await h.ngRunDueAutoFirstMessages({ db });
  assert.equal(results[0].reason, "first_message_send_failed");
  assert.equal(results[1].sent, true);
  assert.equal(db.leads[0].first_message_error, "Provider unavailable");
  assert.equal(db.leads[0].first_message_sent_at, undefined);
  assert.equal(db.bulk_first_message_sending_state.first_message.failed_today, 1);
  assert.equal((await h.ngRunDueAutoFirstMessages({ db }))[0].reason, "bulk_first_message_batch_cooldown");
  assert.equal(h.sends.length, 2);
});

test("ready dry-run reports readiness but does not send or change lead state", async () => {
  const h = harness();
  const lead = makeLead();
  const before = structuredClone(lead);
  const result = await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead] }, lead, dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.variables.exam, lead.exam);
  assert.deepEqual(lead, before);
  assert.equal(h.sends.length, 0);
});

test("opt-outs, enrollment and owner pause still block the welcome", async () => {
  const h = harness();
  for (const overrides of [{ stage: "paid_enrolled" }, { status: "unsubscribed" }, { unsubscribe_status: "stop" }]) {
    const lead = makeLead("one", overrides);
    assert.equal((await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead] }, lead })).sent, false);
  }
  const lead = makeLead();
  assert.equal((await h.ngSendAutoFirstMessageForLead({ db: { leads: [lead], ownerBlocked: true }, lead })).reason, "owner_paused");
  assert.equal(h.sends.length, 0);
});

test("brand-scoped batches never send another product's welcome", async () => {
  const h = harness();
  const db = { leads: [makeLead("ayla", { brand_id: "aylamed" }), makeLead("lms")] };
  const results = await h.ngRunDueAutoFirstMessages({ db, brandId: "nextgen" });
  assert.equal(results.length, 1);
  assert.equal(results[0].lead_id, "lms");
  assert.equal(h.sends.length, 1);
});
