const list = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value ?? "").trim();
const token = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const email = (value) => clean(value).toLowerCase();
const phone = (value) => clean(value).replace(/\D/g, "");

const QUALIFIED_STAGES = new Set([
  "qualified", "hot", "hot_lead", "sales_ready", "mentor_call_booked", "consultation_booked",
  "google_meet_requested", "google_meet_time_collected", "google_meet_booked", "attended_session",
  "payment_pending", "paid", "paid_enrolled", "enrolled", "converted", "won", "closed_won",
]);
const ENROLLED_STAGES = new Set(["paid", "paid_enrolled", "enrolled", "converted", "won", "closed_won"]);
const PAID_STATUSES = new Set(["paid", "completed", "succeeded", "active"]);

function leadStage(lead = {}) {
  return token(lead.stage || lead.lead_stage || lead.status || lead.lead_status);
}

function paymentPaid(payment = {}) {
  return PAID_STATUSES.has(token(payment.payment_status || payment.status || payment.checkout_status || payment.stripe_payment_status));
}

function paymentMatchesLead(payment = {}, lead = {}) {
  const leadKey = clean(lead.id || lead.lead_id);
  if ([payment.lead_id, payment.crm_lead_id, payment.contact_id].map(clean).filter(Boolean).includes(leadKey)) return true;

  const leadEmail = email(lead.email || lead.student_email || lead.customer_email);
  const paymentEmails = [payment.email, payment.customer_email, payment.student_email].map(email).filter(Boolean);
  if (leadEmail && paymentEmails.includes(leadEmail)) return true;

  const leadPhone = phone(lead.whatsapp || lead.phone || lead.mobile);
  const paymentPhones = [payment.whatsapp, payment.phone, payment.mobile, payment.customer_phone].map(phone).filter(Boolean);
  if (leadPhone && paymentPhones.includes(leadPhone)) return true;

  const leadStudent = clean(lead.student_id || lead.user_id);
  const paymentStudent = clean(payment.student_id || payment.user_id);
  return Boolean(leadStudent && paymentStudent && leadStudent === paymentStudent);
}

function leadOutcome(lead = {}, payments = []) {
  const stage = leadStage(lead);
  const paid = list(payments).some((payment) => paymentPaid(payment) && paymentMatchesLead(payment, lead));
  return {
    contacts: 1,
    qualified_conversations: Number(
      lead.qualified === true
      || lead.qualification_complete === true
      || QUALIFIED_STAGES.has(stage),
    ),
    demo_attendance: Number(Boolean(
      lead.demo_started_at
      || lead.demo_login_at
      || lead.demo_activated_at
      || lead.demo_enrollment_id
      || lead.demo_active === true,
    )),
    enrollments: Number(Boolean(paid || lead.enrolled === true || ENROLLED_STAGES.has(stage))),
  };
}

function emptyOutcome() {
  return { contacts: 0, qualified_conversations: 0, demo_attendance: 0, enrollments: 0 };
}

function addOutcome(target, outcome) {
  for (const key of Object.keys(emptyOutcome())) target[key] += Number(outcome[key] || 0);
  return target;
}

export function buildMetaConversionOutcomes({ leads = [], payments = [], brandId = null } = {}) {
  const totals = emptyOutcome();
  const unattributed = emptyOutcome();
  const byAd = {};
  const byCampaign = {};

  for (const lead of list(leads)) {
    if (brandId && lead.brand_id && String(lead.brand_id) !== String(brandId)) continue;
    const adId = clean(lead.meta_ad_id || lead.provider_ad_id);
    const campaignId = clean(lead.meta_campaign_id || lead.provider_campaign_id);
    if (!adId && !campaignId) continue;

    const outcome = leadOutcome(lead, payments);
    addOutcome(totals, outcome);
    if (adId) addOutcome(byAd[adId] ||= emptyOutcome(), outcome);
    if (campaignId) addOutcome(byCampaign[campaignId] ||= emptyOutcome(), outcome);
    if (!adId) addOutcome(unattributed, outcome);
  }

  return {
    totals,
    by_ad: byAd,
    by_campaign: byCampaign,
    unattributed,
    definitions: {
      contacts: "CRM contacts carrying verified click-to-WhatsApp ad attribution",
      qualified_conversations: "Attributed contacts explicitly marked qualified, hot, mentor-ready, payment-ready, or enrolled",
      demo_attendance: "Attributed contacts with evidence that the LMS demo was activated or entered",
      enrollments: "Attributed contacts marked enrolled/paid or matched to a completed payment",
    },
  };
}

