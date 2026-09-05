import { MCCQE_DEMO_BRAND, MCCQE_DEMO_SOURCE, MCCQE_DEMO_DURATION_MS, mccqeDemoPurchaseState } from "./crm-aylamed-demo-lifecycle.js";
import { createAylaConversationState, evaluateAylaConversationDecision } from "./crm-ayla-conversation-engine.js";
import { assessMccqeWhatsAppIntake } from "./crm-aylamed-whatsapp-intake.js";

const clean = (value) => String(value ?? "").trim();
const email = (value) => clean(value).toLowerCase();
const rows = (value) => Array.isArray(value) ? value : Object.values(value || {});
const owner = (row = {}) => clean(row.user_id || row.ayla_user_id || row.userId);
const exam = (row = {}) => clean(row.exam_track_id || row.examTrackId || row.exam_track || row.exam_type || row.exam).toLowerCase().replace(/[^a-z0-9]/g, "");
const isMccqe = (row) => /^mccqe(?:part1|1)?$/.test(exam(row));

// Empty means unverified to the conversation engine. Never use CRM mirror
// prose, a phone match, user-supplied expiry, or a past assistant claim as proof.
export function buildMccqeOperationalContext({ crmDb = {}, aylaDb = {}, lead = {}, now = Date.now(), allowProspect = false, secret = "" } = {}) {
  if (lead.brand_id !== MCCQE_DEMO_BRAND || !lead.id) return {};
  if (!lead.ayla_user_id) return allowProspect
    ? assessMccqeWhatsAppIntake({ crmDb, aylaDb, lead, now, secret }).operational_context || {} : {};
  if (!email(lead.email)) return {};
  const matches = rows(crmDb.leads).filter((row) => row.id === lead.id);
  if (matches.length !== 1) return {};
  const savedLead = matches[0];
  if (savedLead.brand_id !== MCCQE_DEMO_BRAND || savedLead.ayla_user_id !== lead.ayla_user_id
    || email(savedLead.email) !== email(lead.email) || !isMccqe(savedLead)
    || savedLead.brand_routing_review_required === true) return {};
  const users = rows(aylaDb.aylaUsers).filter((row) => row.id === savedLead.ayla_user_id);
  if (users.length !== 1) return {};
  const user = users[0];
  if (email(user.email) !== email(savedLead.email) || clean(user.role || "student") !== "student"
    || ["disabled", "deleted", "inactive"].includes(clean(user.status).toLowerCase())) return {};
  const base = { brand_id: MCCQE_DEMO_BRAND, exam: "MCCQE", paid: mccqeDemoPurchaseState(aylaDb, user.id, now).paid };
  // Account/payment certainty does not depend on the quality of a historical
  // trial record. Preserve it while keeping the trial explicitly unknown.
  const unknownDemo = () => ({ ...base, demo: { status: "unknown", email_delivery_status: "unknown", expires_at: null } });
  const relevant = rows(aylaDb.aylaCrmDemoIssuances).filter((row) => row.user_id === user.id
    || row.crm_lead_id === savedLead.id || email(row.email) === email(savedLead.email));
  // Recipient certainty is independent of trial/enrollment validity. Preserve
  // the binding through unknown-status fallbacks; conflicts never erase it.
  const signed = relevant.filter((row) => row.whatsapp_sender || row.initiation === "verified_whatsapp_private_demo_request");
  if (signed.length) {
    const binding = signed[0];
    base.outbound_whatsapp_sender = binding.whatsapp_sender;
    const sender = (value) => clean(value).replace(/\D/g, "");
    if (signed.length !== 1 || relevant.length !== 1 || !binding.whatsapp_sender
      || binding.brand_id !== MCCQE_DEMO_BRAND || binding.crm_lead_id !== savedLead.id || binding.user_id !== user.id
      || email(binding.email) !== email(savedLead.email)
      || [savedLead.phone, savedLead.whatsapp, savedLead.wa_id].filter(Boolean).some((value) => sender(value) !== binding.whatsapp_sender)
      || savedLead.recipient_phone_number_id !== binding.whatsapp_phone_number_id
      || savedLead.source_integration_id !== binding.whatsapp_integration_id) base.outbound_identity_blocked = true;
  } else if (savedLead.aylamed_whatsapp_intake) base.outbound_identity_blocked = true;
  if (!relevant.length) {
    // A legacy or unlinked trial is not proof that no invitation exists.
    if (savedLead.aylamed_demo?.issuance_id || rows(aylaDb.aylaEnrollments).some((row) => owner(row) === user.id && isMccqe(row)
      && (row.type === "demo" || row.is_demo === true))) return unknownDemo();
    return { ...base, demo: { status: "not_issued", email_delivery_status: "unknown", expires_at: null } };
  }
  if (relevant.length !== 1) return unknownDemo();
  const issuance = relevant[0];
  if (issuance.brand_id !== MCCQE_DEMO_BRAND || issuance.crm_lead_id !== savedLead.id || issuance.user_id !== user.id
    || email(issuance.email) !== email(user.email) || !isMccqe(issuance) || !issuance.id || !issuance.enrollment_id) return unknownDemo();
  const enrollments = rows(aylaDb.aylaEnrollments).filter((row) => row.id === issuance.enrollment_id);
  if (enrollments.length !== 1) return unknownDemo();
  const enrollment = enrollments[0];
  const start = Date.parse(issuance.starts_at), expiry = Date.parse(issuance.expires_at);
  if (owner(enrollment) !== user.id || !isMccqe(enrollment) || enrollment.source !== MCCQE_DEMO_SOURCE
    || enrollment.type !== "demo" || enrollment.is_demo !== true || enrollment.access_granted !== true
    || enrollment.access_starts_at !== issuance.starts_at || enrollment.access_expires_at !== issuance.expires_at
    || enrollment.revoked_at || enrollment.revokedAt || ["revoked", "deleted", "disabled", "pending", "cancelled", "canceled"].includes(clean(enrollment.status).toLowerCase())
    || !Number.isFinite(start) || !Number.isFinite(expiry) || expiry - start !== MCCQE_DEMO_DURATION_MS) return unknownDemo();
  // Unknown delivery cannot establish issuance, activation, or expiry. A
  // confirmed transport failure may be explained without exposing credentials.
  if (issuance.email_delivery_status === "failed") return { ...base, demo: { status: "failed", email_delivery_status: "failed", expires_at: null } };
  const acceptedAt = Date.parse(issuance.email_delivery_at);
  if (!["accepted", "delivered"].includes(issuance.email_delivery_status)
    || !Number.isFinite(acceptedAt) || acceptedAt > now
    || (clean(enrollment.status).toLowerCase() === "expired" && now < expiry)) return unknownDemo();
  if (!["issued", "active", "expired"].includes(clean(issuance.status || "issued"))) return unknownDemo();
  return { ...base, demo: { status: now >= expiry ? "expired" : now >= start ? "active" : "issued",
    email_delivery_status: issuance.email_delivery_status, expires_at: new Date(expiry).toISOString() } };
}

export function validateMccqeAutomaticOutbound({ lead = {}, messages = [], operationalContext = {}, text = "", subject = "", mediaUrl = "", mediaId = "", templateName = "", to = "" } = {}) {
  if (lead.brand_id !== MCCQE_DEMO_BRAND) return { ok: true };
  if (operationalContext?.brand_id !== MCCQE_DEMO_BRAND || operationalContext?.exam !== "MCCQE") {
    return { ok: false, reason: "aylamed_outbound_identity_unverified" };
  }
  if (operationalContext.identity_scope === "whatsapp_prospect" && (operationalContext.prospect?.sender_verified !== true
    || String(to).replace(/\D/g, "") !== operationalContext.prospect.sender)) return { ok: false, reason: "aylamed_prospect_recipient_mismatch" };
  if (operationalContext.outbound_identity_blocked || (operationalContext.outbound_whatsapp_sender
    && String(to).replace(/\D/g, "") !== operationalContext.outbound_whatsapp_sender)) return { ok: false, reason: "aylamed_demo_recipient_mismatch" };
  const violations = evaluateAylaConversationDecision({ lead, state: createAylaConversationState({ lead, messages }), messages,
    protectedActionContext: operationalContext, decision: { action: "reply_only", ask_field: "none", reply: `${clean(text)}${subject ? `\n${clean(subject)}` : ""}`,
      follow_up: null, media_keys: [], payment_followup: { disposition: "none" }, experience_response: { outcome: "none" } } });
  if (mediaUrl || mediaId) violations.push("aylamed_automatic_media_not_enabled");
  if (templateName) violations.push("aylamed_automatic_template_not_enabled");
  return violations.length ? { ok: false, reason: "aylamed_outbound_context_rejected", violations: [...new Set(violations)] } : { ok: true };
}
