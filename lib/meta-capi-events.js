// Meta Conversions API events that teach the ad pixel who actually pays.
// Pure builders only: the server sends them and records what was reported.
import crypto from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const hash = (value) => {
  const text = clean(value).toLowerCase();
  return text ? crypto.createHash("sha256").update(text).digest("hex") : "";
};
const digits = (value) => clean(value).replace(/\D/g, "");

const QUALIFIED_STAGES = new Set([
  "qualified", "hot", "hot_lead", "sales_ready", "mentor_call_booked", "consultation_booked",
  "google_meet_requested", "google_meet_time_collected", "google_meet_booked", "attended_session",
  "payment_pending",
]);
const PAID_STAGES = new Set(["paid", "paid_enrolled", "enrolled", "converted", "won", "closed_won"]);

function stageOf(lead = {}) {
  return clean(lead.stage || lead.lead_stage || lead.status || lead.lead_status).toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function userData({ email = "", phone = "", fbp = "", fbc = "", ip = "", userAgent = "" } = {}) {
  const data = {};
  if (hash(email)) data.em = [hash(email)];
  if (digits(phone)) data.ph = [hash(digits(phone))];
  if (clean(fbp)) data.fbp = clean(fbp);
  if (clean(fbc)) data.fbc = clean(fbc);
  if (clean(ip)) data.client_ip_address = clean(ip);
  if (clean(userAgent)) data.client_user_agent = clean(userAgent);
  return data;
}

// A paid Stripe checkout on the website. Returns null for anything that is not a real paid sale.
export function buildWebsitePurchaseEvent(session = {}, { sourceUrl = "https://nextgenusmle.live/", now = Date.now() } = {}) {
  const amount = Number(session.amount_total || 0) / 100;
  const paid = clean(session.payment_status).toLowerCase() === "paid";
  if (!session.id || !paid || !(amount > 0)) return null;
  const details = session.customer_details || {};
  const user = userData({ email: details.email || session.customer_email, phone: details.phone });
  if (!user.em && !user.ph) return null;
  const metadata = session.metadata || {};
  return {
    event_name: "Purchase",
    event_time: Math.floor(Number(now) / 1000),
    event_id: `nextgen-purchase-${session.id}`,
    action_source: "website",
    event_source_url: sourceUrl,
    user_data: user,
    custom_data: {
      currency: clean(session.currency || "usd").toUpperCase(),
      value: Math.round(amount * 100) / 100,
      content_name: clean(metadata.planName || metadata.plan_name || "NextGen USMLE plan"),
      content_ids: [clean(metadata.courseId || metadata.course_id || metadata.planId || metadata.plan_id)].filter(Boolean),
    },
  };
}

// A click-to-WhatsApp lead reported back to Meta from the WhatsApp chat (business messaging).
export function buildWhatsAppAdEvent({ lead = {}, eventName = "", wabaId = "", value = 0, currency = "USD", now = Date.now() } = {}) {
  const clickId = clean(lead.meta_ctwa_clid);
  if (!clickId || !clean(wabaId) || !["LeadSubmitted", "Purchase"].includes(eventName)) return null;
  const event = {
    event_name: eventName,
    event_time: Math.floor(Number(now) / 1000),
    event_id: `nextgen-ctwa-${eventName.toLowerCase()}-${clean(lead.id) || clickId}`,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: { whatsapp_business_account_id: clean(wabaId), ctwa_clid: clickId },
  };
  if (eventName === "Purchase") event.custom_data = { currency: clean(currency || "USD").toUpperCase(), value: Number(value) || 0 };
  return event;
}

// Leads that came from a WhatsApp ad and reached a stage Meta hasn't been told about yet.
export function pendingWhatsAppAdReports(leads = [], { limit = 20 } = {}) {
  const out = [];
  for (const lead of Array.isArray(leads) ? leads : []) {
    if (!clean(lead.meta_ctwa_clid)) continue;
    const reported = lead.meta_capi_reported || {};
    const stage = stageOf(lead);
    const paid = PAID_STAGES.has(stage) || lead.enrolled === true || lead.paid === true || lead.is_paid === true;
    const qualified = paid || QUALIFIED_STAGES.has(stage) || lead.qualified === true || lead.qualification_complete === true;
    if (qualified && !reported.lead_submitted) out.push({ lead, eventName: "LeadSubmitted" });
    if (paid && !reported.purchase) out.push({ lead, eventName: "Purchase" });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export function markWhatsAppAdReported(lead = {}, eventName = "", at = new Date().toISOString()) {
  const key = eventName === "Purchase" ? "purchase" : "lead_submitted";
  lead.meta_capi_reported = { ...(lead.meta_capi_reported || {}), [key]: at };
  return lead;
}
