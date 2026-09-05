import { createHash } from "node:crypto";
import { aylaShellEnrollmentActive } from "./aylamed-student-shell.js";

export const MCCQE_DEMO_BRAND = "brand_aylamed";
export const MCCQE_DEMO_SOURCE = "crm_mccqe_demo";
export const MCCQE_DEMO_DURATION_MS = 5 * 60 * 60 * 1000;
const clean = (value) => String(value ?? "").trim();
const email = (value) => clean(value).toLowerCase();
const rows = (value) => Array.isArray(value) ? value : Object.values(value || {});
const owner = (row = {}) => clean(row.user_id || row.ayla_user_id || row.userId);
const exam = (row = {}) => clean(row.exam_track_id || row.examTrackId || row.exam_track || row.exam).toLowerCase().replace(/[^a-z0-9]/g, "");
const isMccqe = (row) => /^mccqe(?:part1|1)?$/.test(exam(row));
const error = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

export function mccqeDemoEnabled(env = process.env) {
  return clean(env.AYLAMED_MCCQE_DEMO_FLOW_ENABLED).toLowerCase() === "true";
}

export function mccqeDemoPilotStatus(env = process.env) {
  const key = "AYLAMED_MCCQE_DEMO_PILOT_LEAD_ID";
  if (!Object.prototype.hasOwnProperty.call(env, key)) return { restricted: false, valid: true, leadId: "" };
  const raw = env[key], leadId = typeof raw === "string" ? raw.trim() : "";
  const valid = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(leadId)
    && !/^(?:all|any|null|undefined|true|false)$/i.test(leadId);
  return { restricted: true, valid, leadId: valid ? leadId : "" };
}

export function mccqeDemoPilotEligibility(leadId, env = process.env) {
  const pilot = mccqeDemoPilotStatus(env);
  if (!pilot.restricted) return { ok: true };
  if (!pilot.valid) return { ok: false, reason: "aylamed_demo_pilot_configuration_invalid" };
  return typeof leadId === "string" && leadId === pilot.leadId
    ? { ok: true } : { ok: false, reason: "aylamed_demo_pilot_lead_restricted" };
}

export function assertMccqeDemoPilotLead(leadId, env = process.env) {
  const result = mccqeDemoPilotEligibility(leadId, env);
  if (!result.ok) throw Object.assign(error("This private demo request is outside the configured pilot scope."), { code: result.reason });
}

export function assertMccqeDemoDispatchAllowed(leadId, env = process.env) {
  if (!mccqeDemoEnabled(env)) throw Object.assign(error("The private MCCQE CRM demo flow is not enabled."), { code: "aylamed_demo_flow_disabled" });
  assertMccqeDemoPilotLead(leadId, env);
}

export function validateMccqeDemoRequest(body = {}, lead = {}) {
  if (body.brand_id !== MCCQE_DEMO_BRAND || lead.brand_id !== MCCQE_DEMO_BRAND
    || !lead.id || clean(body.crm_lead_id) !== clean(lead.id)) throw error("A confirmed AylaMed CRM lead is required.");
  assertMccqeDemoPilotLead(lead.id);
  if (!isMccqe(body) || !isMccqe(lead)) throw error("Both the CRM lead and invitation must be assigned to MCCQE.");
  const recipient = email(body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient !== email(lead.email)) {
    throw error("The invitation email must match the confirmed email on this AylaMed lead.");
  }
  const requestKey = clean(body.idempotency_key);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,159}$/.test(requestKey)) throw error("A stable idempotency_key of 8–160 characters is required.", 400);
  if (body.send_email === false || body.preserve_existing_access === true || body.return_password === true) {
    throw error("CRM demo invitations require email delivery and do not return or reset existing passwords.", 400);
  }
  return { email: recipient, request_key: requestKey, crm_lead_id: clean(lead.id), brand_id: MCCQE_DEMO_BRAND, exam_track_id: "mccqe" };
}

export function mccqeDemoIssuanceId(userId) {
  return `AYLA-CRM-DEMO-${createHash("sha256").update(`${MCCQE_DEMO_BRAND}:${clean(userId)}:mccqe`).digest("hex").slice(0, 24)}`;
}

export function findMccqeDemoReplay(db = {}, request = {}, userId = "") {
  const all = rows(db.aylaCrmDemoIssuances);
  const keyed = all.find((item) => clean(item.request_key) === request.request_key);
  if (keyed && (keyed.brand_id !== request.brand_id || keyed.crm_lead_id !== request.crm_lead_id || email(keyed.email) !== request.email)) {
    throw error("This idempotency key already belongs to another invitation.");
  }
  const existing = keyed || all.find((item) => item.brand_id === MCCQE_DEMO_BRAND && isMccqe(item)
    && ((userId && item.user_id === userId) || email(item.email) === request.email));
  if (existing && existing.crm_lead_id !== request.crm_lead_id) throw error("This MCCQE trial already belongs to another AylaMed CRM lead; review the existing record.");
  return existing || null;
}

export function mccqeDemoPurchaseState(db = {}, userId = "", now = Date.now()) {
  const owned = rows(db.aylaEnrollments).filter((row) => owner(row) === clean(userId) && isMccqe(row));
  const nonDemo = owned.filter((row) => row.is_demo !== true && clean(row.type).toLowerCase() !== "demo" && row.source !== MCCQE_DEMO_SOURCE);
  const paidEnrollment = nonDemo.find((row) => clean(row.type).toLowerCase() === "paid" && aylaShellEnrollmentActive(row, now));
  const purchase = rows(db.aylaPayments).find((row) => {
    if (owner(row) !== clean(userId) || !["paid", "completed", "succeeded"].includes(clean(row.payment_status || row.status).toLowerCase())) return false;
    const scoped = row.enrollment_id ? owned.find((enrollment) => clean(enrollment.id) === clean(row.enrollment_id)) : null;
    if (!isMccqe(row) && !scoped) return false;
    const verifiedCheckout = ["aylamed_free_checkout", "aylamed_stripe_webhook", "aylamed_invoice_paid"].includes(clean(row.source))
      && scoped?.type === "paid" && scoped?.is_demo !== true && scoped?.source !== MCCQE_DEMO_SOURCE;
    return Number(row.final_amount_cents ?? row.amount_cents ?? 0) > 0 || verifiedCheckout;
  });
  const activeAccess = nonDemo.find((row) => aylaShellEnrollmentActive(row, now));
  return { paid: Boolean(paidEnrollment || purchase), active_access: Boolean(activeAccess), payment_id: purchase?.id || null, enrollment_id: paidEnrollment?.id || activeAccess?.id || null };
}

export function mccqeDemoEmailAccepted(provider = {}, recipient = "") {
  if (provider.provider === "smtp") return rows(provider.accepted).some((item) => email(typeof item === "object" ? item.address : item) === email(recipient))
    && !rows(provider.rejected).some((item) => email(typeof item === "object" ? item.address : item) === email(recipient));
  if (provider.provider === "resend") return Boolean(provider.id);
  if (provider.provider === "sendgrid") return Number(provider.status) === 202;
  return false;
}

export function mccqeDemoResource(issuance = {}) {
  if (issuance.email_delivery_status !== "accepted") return null;
  return { kind: "aylamed_demo", id: issuance.id, issuance_id: issuance.id, title: "five-hour AylaMed MCCQE demo",
    url: issuance.login_url, channel: "whatsapp", starts_at: issuance.starts_at, expires_at: issuance.expires_at,
    user_id: issuance.user_id, enrollment_id: issuance.enrollment_id, exam_track_id: "mccqe" };
}

export function mccqeDemoSendEligibility({ db = {}, lead = {}, item = {}, now = Date.now() } = {}) {
  if (item.kind !== "aylamed_demo") return { ok: true };
  if (lead.brand_id !== MCCQE_DEMO_BRAND) return { ok: false, reason: "aylamed_demo_brand_mismatch" };
  const pilot = mccqeDemoPilotEligibility(lead.id);
  if (!pilot.ok) return pilot;
  const issuance = rows(db.aylaCrmDemoIssuances).find((row) => row.id === clean(item.issuance_id || item.resource_id));
  if (!issuance || issuance.brand_id !== MCCQE_DEMO_BRAND || !isMccqe(issuance)
    || issuance.crm_lead_id !== lead.id || issuance.email !== email(lead.email)
    || issuance.user_id !== item.user_id || issuance.enrollment_id !== item.enrollment_id
    || clean(lead.ayla_user_id) !== issuance.user_id || clean(item.exam_track_id) !== "mccqe"
    || item.url !== issuance.login_url || item.expires_at !== issuance.expires_at || item.starts_at !== issuance.starts_at) {
    return { ok: false, reason: "aylamed_demo_link_unverified" };
  }
  const user = rows(db.aylaUsers).find((row) => row.id === issuance.user_id);
  if (!user || email(user.email) !== issuance.email || ["deleted", "disabled", "inactive"].includes(clean(user.status).toLowerCase())) return { ok: false, reason: "aylamed_demo_user_unavailable" };
  const payment = mccqeDemoPurchaseState(db, issuance.user_id, now);
  if (payment.paid || issuance.cancelled_reason === "purchased") return { ok: false, reason: "aylamed_demo_purchased", cancel: true, paid: true, payment };
  if (payment.active_access) return { ok: false, reason: "aylamed_demo_other_access_active", cancel: true };
  const enrollment = rows(db.aylaEnrollments).find((row) => row.id === issuance.enrollment_id);
  if (!enrollment || owner(enrollment) !== issuance.user_id || !isMccqe(enrollment)
    || enrollment.source !== MCCQE_DEMO_SOURCE || enrollment.type !== "demo" || enrollment.is_demo !== true
    || enrollment.access_expires_at !== issuance.expires_at || enrollment.access_starts_at !== issuance.starts_at
    || enrollment.access_granted !== true || enrollment.revoked_at || ["revoked", "deleted", "disabled", "cancelled", "canceled"].includes(clean(enrollment.status).toLowerCase())
    || issuance.email_delivery_status !== "accepted") return { ok: false, reason: "aylamed_demo_entitlement_unverified" };
  const start = Date.parse(issuance.starts_at), expiry = Date.parse(issuance.expires_at);
  if (!Number.isFinite(start) || expiry - start !== MCCQE_DEMO_DURATION_MS) return { ok: false, reason: "aylamed_demo_window_unverified" };
  if (now < expiry) return { ok: false, reason: "aylamed_demo_not_expired" };
  return { ok: true, issuance };
}

export function cancelMccqeDemoSales(lead = {}, { reason = "purchased", now = new Date().toISOString() } = {}) {
  if (lead.brand_id !== MCCQE_DEMO_BRAND) return false;
  let changed = false;
  for (const item of lead.ayla_experience_followups || []) {
    if (item.kind !== "aylamed_demo" || ["checkin_sent", "cancelled", "responded", "declined"].includes(item.status)) continue;
    item.status = "cancelled"; item.cancelled_reason = reason; item.updated_at = now; changed = true;
  }
  if (reason === "purchased") {
    lead.payment_status = "paid"; lead.paid = true; lead.stage = "paid_enrolled"; lead.lead_stage = "paid_enrolled";
    lead.aylamed_demo_purchased_at = lead.aylamed_demo_purchased_at || now;
    if (lead.ayla_payment_followup) lead.ayla_payment_followup.status = "cancelled";
    changed = true;
  }
  return changed;
}

// The registry is process-local and accepts object identity, never serialized
// request fields. Each reservation gets one attempt and a fresh entitlement read.
export function createMccqeDemoOutboundGuard({ verify } = {}) {
  const capabilities = new WeakMap();
  return {
    issue({ lead, item, text, to }) {
      if (lead?.brand_id !== MCCQE_DEMO_BRAND || item?.kind !== "aylamed_demo" || !item.reservation_id) throw error("A reserved AylaMed demo check-in is required.");
      assertMccqeDemoPilotLead(lead.id);
      const capability = Object.freeze({});
      capabilities.set(capability, { lead_id: lead.id, item_id: item.id, reservation_id: item.reservation_id, text: clean(text), to: clean(to) });
      return capability;
    },
    async consume(capability, { lead, text, to, channel } = {}) {
      const held = capability && typeof capability === "object" ? capabilities.get(capability) : null;
      if (!held) return { ok: false, reason: "aylamed_demo_capability_invalid" };
      capabilities.delete(capability);
      const item = lead?.ayla_experience_followups?.find((row) => row.id === held.item_id);
      if (channel !== "whatsapp" || lead?.brand_id !== MCCQE_DEMO_BRAND || lead.id !== held.lead_id
        || item?.kind !== "aylamed_demo" || item.reservation_id !== held.reservation_id
        || clean(text) !== held.text || clean(to) !== held.to || typeof verify !== "function") {
        return { ok: false, reason: "aylamed_demo_capability_mismatch" };
      }
      const pilot = mccqeDemoPilotEligibility(lead.id);
      if (!pilot.ok) return pilot;
      const result = await verify({ context: { lead }, item, phase: "provider_send" });
      const currentPilot = mccqeDemoPilotEligibility(lead.id);
      return currentPilot.ok ? result : currentPilot;
    },
  };
}

export function preserveMccqeDemoLedgerSnapshot(latest = {}, incoming = {}) {
  const retained = { ...incoming, aylaCrmDemoIssuances: { ...(incoming.aylaCrmDemoIssuances || {}), ...(latest.aylaCrmDemoIssuances || {}) } };
  for (const issuance of rows(latest.aylaCrmDemoIssuances)) {
    // A legacy writer whose snapshot predates this issuance must not erase the
    // account it just created. An intentional later deletion sees the ledger.
    if (incoming.aylaCrmDemoIssuances?.[issuance.id]) continue;
    for (const [collection, id] of [["aylaUsers", issuance.user_id], ["aylaEnrollments", issuance.enrollment_id]]) {
      if (!incoming[collection]?.[id] && latest[collection]?.[id]) retained[collection] = { ...(retained[collection] || {}), [id]: latest[collection][id] };
    }
    const enrollment = latest.aylaEnrollments?.[issuance.enrollment_id];
    for (const [collection, id] of [["aylaStudents", enrollment?.student_id], ["aylaPlans", enrollment?.plan_id]]) {
      if (id && !incoming[collection]?.[id] && latest[collection]?.[id]) retained[collection] = { ...(retained[collection] || {}), [id]: latest[collection][id] };
    }
  }
  return retained;
}
