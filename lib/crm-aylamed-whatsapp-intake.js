import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { integrationSupportsBrand, resolveInboundIntegrationSelection } from "./crm-brand-routing.js";
import { MCCQE_DEMO_BRAND, mccqeDemoEnabled, mccqeDemoPurchaseState } from "./crm-aylamed-demo-lifecycle.js";

const clean = (value) => String(value ?? "").trim();
const email = (value) => clean(value).toLowerCase();
const phone = (value) => clean(value).replace(/\D/g, "");
const rows = (value) => Array.isArray(value) ? value : Object.values(value || {});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const DAY = 86400000;
const unknownDemo = () => ({ status: "unknown", email_delivery_status: "unknown", expires_at: null });
const REVIEW = "Your request needs a team review before any access changes. Please wait for the team to help here.";
const fail = (reason, action = "review", reply = REVIEW) => ({ action, reason, reply, request: null });

export function mccqeWhatsAppIntakeEnabled(env = process.env) {
  return mccqeDemoEnabled(env) && clean(env.AYLAMED_MCCQE_WHATSAPP_INTAKE_ENABLED).toLowerCase() === "true";
}

// This is a separate proof for the private-demo path, not a change to legacy
// webhook acceptance. The secret is never stored; signed bytes stay server-side.
export function mccqeMetaInboundProof({ rawBody, signature, secret, receivedAt = new Date().toISOString() } = {}) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 131072 || !clean(secret)
    || !/^sha256=[a-f0-9]{64}$/i.test(clean(signature))) return null;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(clean(signature).slice(7), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return { version: 1, raw_body_base64: rawBody.toString("base64"), signature: clean(signature), received_at: receivedAt };
}

export function mccqeInboundDisposition(text = "") {
  const value = clean(text);
  if (/\b(?:stop|unsubscribe|do not (?:contact|message)|don['’]?t (?:contact|message)|remove me|wrong number|not interested)\b/i.test(value)) return "stop";
  if (/\b(?:don['’]?t|do not|never)\s+(?:send|email|give|activate)|\b(?:no|not now|later|wait|hold on)\b.{0,35}\b(?:demo|trial|invitation)\b/i.test(value)) return "stop";
  if (/\b(?:i|we)(?:['’]ve| have)?(?: already)? (?:paid|purchased|bought|subscribed)\b|\balready paid\b/i.test(value)) return "payment_review";
  const enquiry = value.replace(/\b(?:not|never)\s+(?:looking for|seeking|applying for)\s+(?:a |an )?(?:job|employment|vacancy|internship)\b/ig, "");
  if (/\b(?:looking for|seeking|need|apply for|applying for|offer me|any)\s+(?:a |an )?(?:job|employment|vacancy|vacancies|internship)\b|\b(?:partnership|collaborat(?:e|ion)|sponsorship)\b|\b(?:i|we)\s+(?:offer|provide|sell|can (?:offer|provide|improve|design))\b.{0,80}\b(?:seo|marketing|design|leads|website|services)\b|\b(?:i am|i['’]m)\s+(?:an? )?(?:seo|graphic designer|web developer|digital marketer)\b/i.test(enquiry)) return "irrelevant";
  if (/\b(?:i am|i['’]m)\s+not\s+(?:a )?(?:doctor|medical student|medical graduate|mccqe (?:student|aspirant))\b/i.test(value)) return "irrelevant";
  return "candidate";
}

export function mccqeIntakeLeadBlocked(lead = {}) {
  if (["opted_out", "opt_out", "unsubscribed", "do_not_contact", "stop_requested", "suppressed", "ai_suppressed", "irrelevant_filter_active", "brand_routing_review_required", "human_takeover", "human_takeover_active", "manual_takeover", "ai_paused"].some((key) => lead[key] === true)) return true;
  if ([lead.ai_mode, lead.automation_mode].some((v) => ["manual", "draft", "ai_draft", "paused", "human", "off"].includes(clean(v).toLowerCase()))) return true;
  if ([lead.stage, lead.lead_stage, lead.status, lead.ayla_conversation_state?.stage].some((v) => ["stopped", "not_interested", "lost", "unsubscribed", "deleted", "handoff", "human_handoff", "paid_enrolled", "enrolled_support"].includes(clean(v).toLowerCase()))) return true;
  if (lead.ai_enabled === false || [lead.unsubscribe_status, lead.opt_out_status].some((v) => ["stop", "stopped", "opted_out", "unsubscribed", "inactive"].includes(clean(v).toLowerCase()))) return true;
  if ([lead.paid, lead.is_paid, lead.enrolled, lead.is_enrolled, lead.manual_paid, lead.payment_completed].some((v) => v === true)) return true;
  return Boolean(lead.human_handoff_active || lead.handoff_pending || lead.assigned_human_agent_id || lead.google_meet_requested || lead.google_meet_confirmed);
}

function signedMessage(row, { secret, now }) {
  const proof = row.aylamed_inbound_proof;
  if (proof?.version !== 1 || !mccqeMetaInboundProof({ rawBody: Buffer.from(clean(proof.raw_body_base64), "base64"), signature: proof.signature, secret })) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(proof.raw_body_base64, "base64").toString("utf8")); } catch { return null; }
  // Batches/attachments need explicit expansion first; do not guess which text
  // or sender the generic parser selected.
  const entries = payload.entry, changes = entries?.[0]?.changes, value = changes?.[0]?.value;
  if (entries?.length !== 1 || changes?.length !== 1 || value?.messages?.length !== 1 || value?.contacts?.length !== 1) return null;
  const message = value.messages[0], contact = value.contacts[0];
  const at = Number(message.timestamp) * 1000, received = Date.parse(proof.received_at);
  if (message.type !== "text" || !message.id || message.id !== (row.platform_message_id || row.provider_message_id)
    || clean(message.text?.body) !== clean(row.text || row.message_text)
    || !phone(message.from) || phone(message.from) !== phone(contact.wa_id)
    || !Number.isFinite(at) || at > now + 300000 || now - at > DAY
    || !Number.isFinite(received) || received > now + 300000 || now - received > DAY) return null;
  return { id: row.id, provider_id: message.id, text: clean(message.text.body), sender: phone(message.from),
    asset: clean(value.metadata?.phone_number_id), at, proof_hash: digest(proof.raw_body_base64) };
}

export function assessMccqeWhatsAppIntake({ crmDb = {}, aylaDb = null, lead = {}, secret = "", now = Date.now(), expectedInboundId = "", reservedIssuanceId = "" } = {}) {
  if (lead.brand_id !== MCCQE_DEMO_BRAND || !lead.id) return fail("brand_unverified");
  const matches = rows(crmDb.leads).filter((row) => row.id === lead.id);
  if (matches.length !== 1 || matches[0].brand_id !== MCCQE_DEMO_BRAND) return fail("lead_unverified");
  const saved = matches[0];
  if (mccqeIntakeLeadBlocked(saved)) return fail("lead_suppressed");
  if (crmDb.settings?.ai_paused === true || crmDb.settings?.global_ai_enabled === false
    || rows(crmDb.handoffs).some((row) => row.lead_id === saved.id && !["closed", "resolved", "cancelled", "completed"].includes(clean(row.status).toLowerCase()))) return fail("automation_paused");
  if (rows(crmDb.suppression_list).some((row) => !["inactive", "removed"].includes(row.status)
    && ((row.email && email(row.email) === email(saved.email)) || (row.phone && [saved.phone, saved.whatsapp, saved.wa_id].some((value) => value && phone(value) === phone(row.phone)))))) return fail("lead_suppressed");
  const inbound = rows(crmDb.conversations).filter((row) => row.lead_id === saved.id && row.direction === "inbound")
    .sort((a, b) => Date.parse(a.created_at || a.timestamp) - Date.parse(b.created_at || b.timestamp));
  const latest = inbound.at(-1);
  if (!latest || latest.brand_id !== MCCQE_DEMO_BRAND || clean(latest.platform || latest.channel) !== "whatsapp") return fail("inbound_unverified");
  const current = signedMessage(latest, { secret, now });
  if (!current || (expectedInboundId && ![current.id, current.provider_id].includes(expectedInboundId))) return fail("inbound_unverified");
  const selection = resolveInboundIntegrationSelection({ integrations: rows(crmDb.integrations), platform: "whatsapp",
    identity: { phone_number_id: current.asset }, explicitIntegrationId: saved.source_integration_id || "" });
  const integration = selection.integration;
  if (selection.quarantine || !integration || clean(integration.status) !== "connected" || !integrationSupportsBrand(integration, MCCQE_DEMO_BRAND)
    || latest.integration_id !== integration.id || saved.source_integration_id !== integration.id
    || saved.recipient_phone_number_id !== current.asset) return fail("recipient_asset_unverified");
  const contactPhones = [saved.wa_id, saved.whatsapp, saved.phone].filter(Boolean).map(phone);
  if (!contactPhones.length || contactPhones.some((value) => value !== current.sender)) return fail("sender_mismatch");
  if (rows(crmDb.leads).some((row) => row.id !== saved.id && row.brand_id === MCCQE_DEMO_BRAND
    && [row.wa_id, row.whatsapp, row.phone].some((value) => value && phone(value) === current.sender))) return fail("sender_ambiguous");
  const trusted = inbound.map((row) => ({ row, signed: signedMessage(row, { secret, now }) }))
    .filter(({ row, signed }) => signed && row.brand_id === MCCQE_DEMO_BRAND && row.integration_id === integration.id
      && signed.sender === current.sender && signed.asset === current.asset).map(({ signed }) => signed);
  const unique = [...new Map(trusted.map((row) => [row.provider_id, row])).values()];
  const dispositions = unique.map((row) => mccqeInboundDisposition(row.text));
  if (dispositions.includes("stop")) return fail("student_stop", "stop", "");
  if (dispositions.includes("payment_review")) return fail("student_reports_payment");
  if (mccqeInboundDisposition(current.text) === "irrelevant") return fail("irrelevant_enquiry", "ignore", "");
  if (!aylaDb || !aylaDb.aylaUsers || !aylaDb.aylaEnrollments || !aylaDb.aylaPayments) return fail("account_store_unverified");
  const context = { brand_id: MCCQE_DEMO_BRAND, exam: "MCCQE", identity_scope: "whatsapp_prospect", paid: null,
    prospect: { sender_verified: true, sender: current.sender, phone_number_id: current.asset, integration_id: integration.id,
      exam_confirmed: false, email_student_confirmed: false, email_ownership_verified: false }, demo: unknownDemo() };
  const qualify = (action, reply) => ({ ...fail(action, action, reply), operational_context: context });
  const hold = (reason) => ({ ...fail(reason), operational_context: context });
  if (unique.some((row) => /\b(?:IELTS|USMLE|PLAB|AMC|NCLEX)\b/i.test(row.text))) return fail("exam_needs_review");
  const examEvidence = unique.find((row) => /^(?:yes[,!. ]*)?(?:i am|i['’]m|i have|i['’]ve|my exam is|i (?:want|plan|intend|am planning) to (?:take|sit))\b.{0,140}\bMCCQE(?:\s*(?:1|part\s*1))?\b/i.test(row.text)
    && !/\b(?:not|don['’]?t|do not|never)\b/i.test(row.text));
  if (!examEvidence) return qualify("qualify_exam", "AylaMed helps with exam-specific preparation. Are you a doctor or medical student preparing for the MCCQE?");
  context.prospect.exam_confirmed = true;
  const roleEvidence = unique.find((row) => /^(?:yes[,!. ]*)?(?:i am|i['’]m)\s+(?:an? )?(?:doctor|physician|medical student|medical graduate)\b/i.test(row.text));
  if (!roleEvidence) return qualify("qualify_role", "Are you a doctor, medical graduate or medical student preparing for the MCCQE?");
  const requested = unique.findLast((row) => /^(?:yes[,!. ]*)?(?:please\s+)?(?:(?:send|email|give)\s+(?:me\s+|my\s+)?|i\s+(?:want|would like|am requesting)\s+|can you\s+(?:send|email|give)\s+).{0,100}\b(?:demo|trial)\b/i.test(row.text)
    && !/\b(?:not|don['’]?t|do not|later|tomorrow|next week|if|someone|friend)\b/i.test(row.text));
  if (!requested) return qualify("request_demo", "AylaMed combines an MCCQE starting profile, a personal roadmap, lectures, question practice and flashcards. Would you like to request the private five-hour demo by email?");
  const emails = unique.flatMap((row) => [...row.text.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/ig)].map((match) => ({ email: email(match[0]), row })));
  const addresses = [...new Set(emails.map((item) => item.email))];
  if (!addresses.length) return qualify("qualify_email", "Which email address would you like to use for your private five-hour MCCQE demo?");
  if (addresses.length !== 1 || (saved.email && email(saved.email) !== addresses[0])) return hold("email_needs_review");
  const address = addresses[0];
  const confirmation = emails.findLast((item) => item.row.provider_id !== emails[0].row.provider_id
    && /^(?:yes[,!. ]*)?(?:i confirm|confirmed|this is my email|my email is)\b/i.test(item.row.text)
    && /\b(?:my email|my address|mine)\b/i.test(item.row.text));
  if (!confirmation) return qualify("confirm_email", `Please confirm by writing “I confirm ${address} is my email” so the invitation goes to the address you intended.`);
  context.prospect.email_student_confirmed = true;
  // This confirms intended delivery, NOT email ownership. Never disclose or
  // link an existing account using a WhatsApp email assertion.
  const users = rows(aylaDb.aylaUsers).filter((row) => email(row.email) === address);
  const prior = rows(aylaDb.aylaCrmDemoIssuances).filter((row) => row.email === address || row.crm_lead_id === saved.id);
  const replay = prior.length === 1 && prior[0].brand_id === MCCQE_DEMO_BRAND && prior[0].crm_lead_id === saved.id
    && prior[0].email === address && prior[0].whatsapp_sender === current.sender && prior[0].whatsapp_phone_number_id === current.asset
    && prior[0].whatsapp_integration_id === integration.id && users.length === 1 && users[0].id === prior[0].user_id ? prior[0] : null;
  if (users.length || prior.length || saved.ayla_user_id) {
    if (!replay || (saved.ayla_user_id && saved.ayla_user_id !== replay.user_id)
      || users[0].role !== "student" || ["disabled", "deleted", "inactive"].includes(users[0].status)) return hold("identity_or_access_review");
    const purchase = mccqeDemoPurchaseState(aylaDb, replay.user_id, now);
    if (purchase.paid || purchase.active_access) return hold("identity_or_access_review");
    if (!["accepted", "delivered"].includes(replay.email_delivery_status)
      && !(replay.id === reservedIssuanceId && replay.email_delivery_status === "reserved")) return hold("delivery_needs_review");
  }
  if (rows(crmDb.leads).some((row) => row.id !== saved.id && row.brand_id === MCCQE_DEMO_BRAND && email(row.email) === address)) return hold("email_needs_review");
  if (!replay && ["aylaPayments", "aylaEnrollments"].some((key) => rows(aylaDb[key]).some((row) => email(row.email || row.user_email || row.student_email) === address))) return hold("identity_or_access_review");
  if (!replay && ![confirmation.row.provider_id, requested.provider_id].includes(current.provider_id)) return hold("fresh_confirmation_required");
  const request = { brand_id: MCCQE_DEMO_BRAND, crm_lead_id: saved.id, exam_track_id: "mccqe", email: address,
    source_inbound_id: current.id, request_inbound_id: requested.provider_id, confirmation_inbound_id: confirmation.row.provider_id,
    whatsapp_sender: current.sender, whatsapp_phone_number_id: current.asset, whatsapp_integration_id: integration.id,
    email_evidence: "student_confirmed_delivery_address", email_ownership_verified: false };
  request.idempotency_key = `wa-mccqe-${digest(JSON.stringify([saved.id, current.sender, current.asset, address])).slice(0, 40)}`;
  return { action: replay ? "replay" : "invite", reason: replay ? "existing_invitation" : "confirmed_private_demo_request", request, operational_context: context,
    reply: replay ? "Your private demo request is already recorded. I can help if you need support with it." : "Your private demo request is ready for processing." };
}
