const COUNTRY_NAMES = new Set([
  "afghanistan", "albania", "algeria", "andorra", "angola", "antigua and barbuda", "argentina", "armenia",
  "australia", "austria", "azerbaijan", "bahamas", "bahrain", "bangladesh", "barbados", "belarus", "belgium",
  "belize", "benin", "bhutan", "bolivia", "bosnia and herzegovina", "botswana", "brazil", "brunei", "bulgaria",
  "burkina faso", "burundi", "cabo verde", "cambodia", "cameroon", "canada", "central african republic", "chad",
  "chile", "china", "colombia", "comoros", "costa rica", "croatia", "cuba", "cyprus", "czech republic",
  "democratic republic of the congo", "denmark", "djibouti", "dominica", "dominican republic", "ecuador", "egypt",
  "el salvador", "equatorial guinea", "eritrea", "estonia", "eswatini", "ethiopia", "fiji", "finland", "france",
  "gabon", "gambia", "georgia", "germany", "ghana", "greece", "grenada", "guatemala", "guinea", "guinea-bissau",
  "guyana", "haiti", "honduras",
  "hong kong", "hungary", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy", "jamaica",
  "iceland", "japan", "jordan", "kazakhstan", "kenya", "kiribati", "kuwait", "kyrgyzstan", "laos", "latvia",
  "lebanon", "lesotho", "liberia", "libya", "liechtenstein", "lithuania", "luxembourg", "madagascar", "malawi",
  "malaysia", "maldives", "mali", "malta", "marshall islands", "mauritania", "mauritius", "mexico", "micronesia",
  "moldova", "monaco", "mongolia", "montenegro", "morocco", "mozambique", "myanmar", "namibia", "nauru",
  "nepal", "netherlands", "new zealand", "nicaragua", "niger", "nigeria", "north korea", "north macedonia", "norway", "oman",
  "pakistan", "palau", "palestine", "panama", "papua new guinea", "paraguay", "peru", "philippines", "poland",
  "portugal", "qatar", "republic of the congo", "romania", "russia", "rwanda", "saint kitts and nevis", "saint lucia",
  "saint vincent and the grenadines", "samoa", "san marino", "sao tome and principe", "saudi arabia", "senegal",
  "serbia", "seychelles", "sierra leone", "singapore", "slovakia", "slovenia", "solomon islands", "somalia",
  "south africa", "south korea", "south sudan", "spain", "sri lanka", "sudan", "suriname", "sweden", "switzerland",
  "syria", "taiwan", "tajikistan", "tanzania", "thailand", "timor-leste", "togo", "tonga", "trinidad and tobago",
  "tunisia", "turkey", "turkmenistan", "tuvalu", "uganda", "ukraine", "united arab emirates", "united kingdom",
  "united states", "uruguay", "uzbekistan", "vanuatu", "vatican city", "venezuela", "vietnam", "yemen", "zambia",
  "zimbabwe", "uae", "uk", "usa", "us",
]);

const FINAL_STAGES = new Set(["enrolled", "paid", "paid_enrolled", "won", "closed_won"]);
const LOST_STAGES = new Set(["lost", "not_interested", "unsubscribed", "stopped", "suppressed"]);

const array = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const token = (value) => lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const unique = (items) => [...new Set(items.filter(Boolean))];

function timeMs(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordTime(record = {}) {
  return timeMs(record.created_at || record.received_at || record.sent_at || record.timestamp || record.updated_at);
}

function leadId(record = {}) {
  return clean(record.lead_id || record.leadId || record.contact_id || record.crm_lead_id || record.id);
}

function isInbound(message = {}) {
  const direction = token(message.direction || message.message_direction);
  return direction === "inbound" || message.inbound === true;
}

function isOutbound(message = {}) {
  const direction = token(message.direction || message.message_direction);
  return direction === "outbound" || message.outbound === true || Boolean(message.sent_at && !message.received_at);
}

function isAcceptedAiReply(message = {}) {
  if (!isOutbound(message)) return false;
  const status = token(message.delivery_status || message.status || message.message_status);
  if (["failed", "blocked", "suppressed", "error", "skipped", "draft", "pending_approval", "duplicate_blocked"].includes(status)) return false;
  const accepted = ["accepted", "queued", "sent", "delivered", "read"].includes(status)
    || Boolean(message.sent_at || message.delivered_at || message.read_at);
  if (!accepted) return false;
  const meta = message.metadata || message.meta || {};
  const markers = [message.sent_by, message.source, message.created_by, message.model, meta.source, meta.sent_by, meta.model];
  return message.is_ai_generated === true || meta.ai_auto === true || meta.ai_generated === true
    || markers.some((value) => /(^|[^a-z0-9])(ai|ayla|bot|assistant)([^a-z0-9]|$)/i.test(clean(value)));
}

function messageText(message = {}) {
  return clean(message.text || message.message_text || message.body || message.message || message.content || message.last_message);
}

function paymentStatus(payment = {}) {
  return token(payment.payment_status || payment.status || payment.checkout_status || payment.stripe_payment_status);
}

function paymentPaid(payment = {}) {
  return ["paid", "completed", "succeeded", "active"].includes(paymentStatus(payment));
}

function paymentNeedsRescue(payment = {}) {
  return ["failed", "expired", "past_due", "unpaid", "incomplete"].includes(paymentStatus(payment));
}

function paymentUsd(payment = {}) {
  const cents = Number(payment.amount_cents ?? payment.final_amount_cents ?? payment.price_cents ?? 0) || 0;
  const dollars = Number(payment.amount_usd ?? payment.revenue_usd ?? payment.value_usd ?? 0) || 0;
  return dollars || cents / 100;
}

function leadRevenueUsd(lead = {}) {
  return Number(
    lead.revenue_generated_usd ?? lead.revenue_usd ?? lead.net_revenue_usd ?? lead.deal_value_usd ??
    lead.payment_amount_usd ?? lead.sale_amount_usd ?? 0
  ) || 0;
}

export function normalizeRevenueCountry(value) {
  const candidate = lower(value).replace(/\s+/g, " ");
  if (!candidate || ["unknown", "country not known", "not known", "n/a", "na", "none"].includes(candidate)) return "Country not known";
  return COUNTRY_NAMES.has(candidate)
    ? candidate.split(" ").map((part) => ["uk", "us", "usa", "uae"].includes(part) ? part.toUpperCase() : `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ")
    : "Country not known";
}

function leadMessages(messages, id) {
  return array(messages).filter((message) => leadId(message) === id).sort((a, b) => recordTime(a) - recordTime(b));
}

function hasAfter(messages, direction, afterMs) {
  return messages.some((message) => direction(message) && recordTime(message) > afterMs);
}

function activityText(messages = []) {
  return messages.map(messageText).join(" \n ").toLowerCase();
}

function paymentMatchesLead(payment = {}, lead = {}) {
  const ids = [payment.lead_id, payment.crm_lead_id, payment.contact_id].map(clean).filter(Boolean);
  if (ids.includes(clean(lead.id || lead.lead_id))) return true;
  const emails = [payment.email, payment.customer_email, payment.student_email].map(lower).filter(Boolean);
  const leadEmail = lower(lead.email || lead.student_email || lead.customer_email);
  if (leadEmail && emails.includes(leadEmail)) return true;
  const paymentStudent = clean(payment.student_id || payment.user_id);
  const leadStudent = clean(lead.student_id || lead.user_id);
  return Boolean(paymentStudent && leadStudent && paymentStudent === leadStudent);
}

function scoreLeadBehavior({ lead = {}, messages = [], payments = [], appointments = [], nowMs = Date.now() } = {}) {
  const text = activityText(messages);
  const stage = token(lead.stage || lead.lead_stage || lead.status);
  const inbound = messages.filter(isInbound);
  const outbound = messages.filter(isOutbound);
  const relatedPayments = payments.filter((payment) => paymentMatchesLead(payment, lead));
  const relatedAppointments = appointments.filter((item) => leadId(item) === clean(lead.id || lead.lead_id));
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push(reason); };

  if (inbound.length) add(15, "student_replied");
  if (inbound.length >= 3) add(8, "engaged_conversation");
  if (/\b(price|cost|fee|payment|pay|discount|installment|enroll)\b/.test(text)) add(18, "commercial_intent");
  if (/\b(call|mentor|meeting|book|schedule|speak|talk)\b/.test(text)) add(12, "mentor_interest");
  if (/\b(demo|live session|class|recording|lecture)\b/.test(text)) add(10, "experience_interest");
  if (lead.demo_started_at || lead.demo_login_at || lead.demo_active === true) add(18, "demo_started");
  if (lead.recording_viewed_at || lead.recording_watched_at || lead.recording_completed === true) add(15, "recording_watched");
  if (lead.live_session_attended === true || lead.attended_session_at || lead.session_attended_at) add(25, "live_session_attended");
  if (relatedAppointments.some((item) => ["scheduled", "booked", "confirmed"].includes(token(item.status)))) add(18, "mentor_call_booked");
  if (relatedAppointments.some((item) => ["completed", "showed", "attended"].includes(token(item.status)))) add(25, "mentor_call_completed");
  if (relatedPayments.some(paymentNeedsRescue)) add(25, "payment_attempted");
  if (relatedPayments.some(paymentPaid) || FINAL_STAGES.has(stage) || lead.enrolled === true) return { score: 100, priority: "converted", reasons: unique([...reasons, "paid_or_enrolled"]) };
  if (LOST_STAGES.has(stage) || lead.unsubscribe_status || lead.opt_out_status) return { score: 0, priority: "do_not_contact", reasons: unique([...reasons, "stopped_or_lost"]) };

  const lastActivity = Math.max(...messages.map(recordTime), timeMs(lead.updated_at || lead.created_at), 0);
  const inactiveDays = lastActivity ? Math.floor((nowMs - lastActivity) / 86400000) : 0;
  if (inactiveDays >= 30) { score -= 20; reasons.push("inactive_30_days"); }
  else if (inactiveDays >= 14) { score -= 12; reasons.push("inactive_14_days"); }
  else if (inactiveDays >= 7) { score -= 5; reasons.push("inactive_7_days"); }
  if (outbound.length) add(3, "contacted");
  score = Math.max(0, Math.min(99, Math.round(score)));
  return { score, priority: score >= 70 ? "urgent" : score >= 50 ? "high" : score >= 25 ? "warm" : "nurture", reasons: unique(reasons) };
}

export function buildLeadRevenueJourney({ lead = {}, messages = [], payments = [], appointments = [], now = new Date() } = {}) {
  const text = activityText(messages);
  const stageToken = token(lead.stage || lead.lead_stage || lead.status);
  const paid = payments.some((payment) => paymentMatchesLead(payment, lead) && paymentPaid(payment)) || FINAL_STAGES.has(stageToken) || lead.enrolled === true;
  const stopped = LOST_STAGES.has(stageToken) || lead.unsubscribe_status === "unsubscribed" || lead.opt_out_status === "stopped";
  const contacted = messages.some(isOutbound) || Boolean(lead.first_message_sent_at || lead.last_contacted_at);
  const identityKnown = Boolean(clean(lead.name || lead.lead_name || lead.student_name) && clean(lead.exam_type || lead.exam_track || lead.exam));
  const needKnown = Boolean(clean(lead.primary_concern || lead.concern || lead.weak_area || lead.exam_date || lead.target_exam_date));
  const valueShown = Boolean(lead.feature_tour_completed_at || lead.programme_explained_at || lead.value_shown_at || /roadmap.*weak|weak.*flashcard|live.*recording/.test(text));
  const experienceOffered = Boolean(lead.demo_offered_at || lead.live_session_link_sent_at || lead.recording_sent_at || /nextgenusmle\.live\/demo|join live|watch.*recording/.test(text));
  const experienceUsed = Boolean(lead.demo_started_at || lead.demo_login_at || lead.recording_viewed_at || lead.recording_watched_at || lead.live_session_attended || lead.attended_session_at);
  const relatedPayments = payments.filter((payment) => paymentMatchesLead(payment, lead));
  const paymentLinkSent = messages.some((message) => isOutbound(message) && /(?:checkout|payment)(?:\s|\S){0,24}(?:link|https?:\/\/)/i.test(messageText(message)));
  const paymentReady = Boolean(lead.payment_link_sent_at || lead.checkout_started_at || relatedPayments.length || paymentLinkSent);
  const appointment = appointments.find((item) => leadId(item) === clean(lead.id || lead.lead_id) && !["cancelled", "canceled"].includes(token(item.status)));

  const steps = [
    { key: "captured", label: "Lead captured", complete: true },
    { key: "contacted", label: "Conversation started", complete: contacted },
    { key: "qualified", label: "Exam and need understood", complete: identityKnown && needKnown },
    { key: "value", label: "Programme value explained", complete: valueShown },
    { key: "experience", label: "Live class, recording or demo offered", complete: experienceOffered },
    { key: "proof", label: "Student experienced the programme", complete: experienceUsed },
    { key: "close", label: "Booking or payment step", complete: paymentReady || Boolean(appointment) },
    { key: "enrolled", label: "Enrolled", complete: paid },
  ];
  const completed = steps.filter((step) => step.complete).length;
  let stage = "new";
  let nextAction = "Start a natural conversation and learn the student's exam.";
  if (stopped) { stage = "stopped"; nextAction = "Do not contact unless the student reopens the conversation."; }
  else if (paid) { stage = "enrolled"; nextAction = "Confirm access and move the student to enrolled support."; }
  else if (paymentReady) { stage = "payment_ready"; nextAction = "Resolve the final concern and help complete enrollment."; }
  else if (experienceUsed) { stage = "experienced"; nextAction = "Ask for feedback, answer objections and move to enrollment or mentor booking."; }
  else if (experienceOffered) { stage = "experience_offered"; nextAction = "Help the student attend live, watch the labelled recording or enter the demo."; }
  else if (valueShown) { stage = "value_explained"; nextAction = "Show the programme in action with the best live, recording or demo route."; }
  else if (identityKnown && needKnown) { stage = "qualified"; nextAction = "Explain the features that solve this student's exact problem."; }
  else if (contacted) { stage = "discovery"; nextAction = "Understand exam, timeline and main difficulty without repeating known questions."; }

  return {
    stage,
    next_action: nextAction,
    completed_steps: completed,
    total_steps: steps.length,
    progress_percent: Math.round((completed / steps.length) * 100),
    steps,
    updated_at: now.toISOString(),
  };
}

function firstResponseMinutes(messages = []) {
  const firstInbound = messages.find(isInbound);
  if (!firstInbound) return null;
  const firstOut = messages.find((message) => isOutbound(message) && recordTime(message) >= recordTime(firstInbound));
  if (!firstOut) return null;
  return Math.max(0, (recordTime(firstOut) - recordTime(firstInbound)) / 60000);
}

function leadCompact(lead, score, journey, messages, payments, appointments, nowMs) {
  const id = clean(lead.id || lead.lead_id);
  const latestInbound = [...messages].reverse().find(isInbound);
  const latestOutbound = [...messages].reverse().find(isOutbound);
  const replyOutstanding = Boolean(latestInbound && (!latestOutbound || recordTime(latestOutbound) < recordTime(latestInbound)));
  const replyAgeMinutes = latestInbound ? Math.max(0, (nowMs - recordTime(latestInbound)) / 60000) : 0;
  const relatedPayments = payments.filter((payment) => paymentMatchesLead(payment, lead));
  const appointment = appointments.find((item) => leadId(item) === id && !["cancelled", "canceled"].includes(token(item.status)));
  return {
    id,
    name: clean(lead.name || lead.lead_name || lead.student_name || lead.full_name) || "Unnamed lead",
    email: clean(lead.email || lead.student_email),
    phone: clean(lead.whatsapp || lead.phone || lead.mobile),
    country: normalizeRevenueCountry(lead.country || lead.country_name || lead.location),
    exam: clean(lead.exam_type || lead.exam_track || lead.exam) || "Exam not known",
    source: clean(lead.utm_source || lead.source_platform || lead.platform || lead.source) || "Direct / Unknown",
    campaign: clean(lead.utm_campaign || lead.campaign_name || lead.campaign || lead.source_campaign) || "No campaign",
    owner_id: clean(lead.owner_id || lead.assigned_agent_id || lead.assigned_to_id || lead.assigned_team_member_id),
    owner_name: clean(lead.owner_name || lead.assigned_agent_name || lead.assigned_to_name) || "Unassigned",
    score: score.score,
    priority: score.priority,
    score_reasons: score.reasons,
    journey,
    reply_outstanding: replyOutstanding,
    reply_age_minutes: Number(replyAgeMinutes.toFixed(1)),
    sla_overdue: replyOutstanding && replyAgeMinutes > 5,
    first_response_minutes: firstResponseMinutes(messages),
    payment_rescue: relatedPayments.some(paymentNeedsRescue),
    paid: relatedPayments.some(paymentPaid) || journey.stage === "enrolled",
    appointment_status: appointment?.status || null,
    last_activity_at: messages.length ? new Date(recordTime(messages[messages.length - 1])).toISOString() : lead.updated_at || lead.created_at || null,
  };
}

function groupAttribution({ leads = [], payments = [], adPerformance = [] } = {}) {
  const groups = new Map();
  const get = (source, campaign, country) => {
    const key = `${source}||${campaign}||${country}`;
    if (!groups.has(key)) groups.set(key, { source, campaign, country, leads: 0, enrollments: 0, revenue_usd: 0, spend_usd: 0 });
    return groups.get(key);
  };
  for (const lead of leads) {
    const source = clean(lead.utm_source || lead.source_platform || lead.platform || lead.source) || "Direct / Unknown";
    const campaign = clean(lead.utm_campaign || lead.campaign_name || lead.campaign || lead.source_campaign) || "No campaign";
    const country = normalizeRevenueCountry(lead.country || lead.country_name || lead.location);
    get(source, campaign, country).leads += 1;
  }
  for (const payment of payments.filter(paymentPaid)) {
    const lead = leads.find((candidate) => paymentMatchesLead(payment, candidate));
    const source = clean(payment.utm_source || payment.source_platform || lead?.utm_source || lead?.source_platform || lead?.platform || lead?.source) || "Direct / Unknown";
    const campaign = clean(payment.utm_campaign || payment.campaign_name || lead?.utm_campaign || lead?.campaign_name || lead?.campaign) || "No campaign";
    const country = normalizeRevenueCountry(payment.country || lead?.country || lead?.country_name || lead?.location);
    const group = get(source, campaign, country);
    group.enrollments += 1;
    group.revenue_usd += paymentUsd(payment) || leadRevenueUsd(lead || {});
  }
  for (const row of adPerformance) {
    const source = clean(row.platform || row.source || row.utm_source) || "Paid ads";
    const campaign = clean(row.campaign_name || row.campaign || row.name || row.utm_campaign) || "No campaign";
    const country = normalizeRevenueCountry(row.country || row.target_country);
    get(source, campaign, country).spend_usd += Number(row.spend_usd || row.spend || row.cost || row.amount_spent || 0) || 0;
  }
  return [...groups.values()].map((row) => ({
    ...row,
    revenue_usd: Number(row.revenue_usd.toFixed(2)),
    spend_usd: Number(row.spend_usd.toFixed(2)),
    conversion_rate: row.leads ? Number(((row.enrollments / row.leads) * 100).toFixed(1)) : 0,
    cost_per_lead_usd: row.leads ? Number((row.spend_usd / row.leads).toFixed(2)) : 0,
    acquisition_cost_usd: row.enrollments ? Number((row.spend_usd / row.enrollments).toFixed(2)) : 0,
    roas: row.spend_usd ? Number((row.revenue_usd / row.spend_usd).toFixed(2)) : 0,
  })).sort((a, b) => b.revenue_usd - a.revenue_usd || b.leads - a.leads);
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

export function buildRevenueOsSnapshot(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const nowMs = now.getTime();
  const leads = array(input.leads);
  const messages = unique([...array(input.messages), ...array(input.conversations)].map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
  const payments = [...array(input.payments), ...array(input.livePayments)];
  const appointments = array(input.appointments);
  const leadRows = leads.map((lead) => {
    const id = clean(lead.id || lead.lead_id);
    const messagesForLead = leadMessages(messages, id);
    const score = scoreLeadBehavior({ lead, messages: messagesForLead, payments, appointments, nowMs });
    const journey = buildLeadRevenueJourney({ lead, messages: messagesForLead, payments, appointments, now });
    return leadCompact(lead, score, journey, messagesForLead, payments, appointments, nowMs);
  }).sort((a, b) => b.score - a.score || timeMs(b.last_activity_at) - timeMs(a.last_activity_at));

  const futureFollowups = array(input.futureFollowups);
  const smartViews = [
    { key: "needs_reply", label: "Needs reply now", description: "A student is waiting for an answer.", items: leadRows.filter((row) => row.reply_outstanding) },
    { key: "sla_overdue", label: "Response overdue", description: "No reply was sent within five minutes.", items: leadRows.filter((row) => row.sla_overdue) },
    { key: "hot", label: "Hot leads", description: "Strong intent or meaningful programme activity.", items: leadRows.filter((row) => row.score >= 50 && !row.paid) },
    { key: "unassigned", label: "Unassigned", description: "These leads do not yet have a human owner.", items: leadRows.filter((row) => !row.owner_id) },
    { key: "payment_rescue", label: "Payment rescue", description: "Checkout expired or payment failed.", items: leadRows.filter((row) => row.payment_rescue) },
    { key: "booked", label: "Calls booked", description: "Upcoming or active mentor appointments.", items: leadRows.filter((row) => row.appointment_status && !["completed", "cancelled", "canceled"].includes(token(row.appointment_status))) },
    { key: "promised", label: "Promised follow-up", description: "The student asked to be contacted later.", items: leadRows.filter((row) => futureFollowups.some((item) => leadId(item) === row.id && ["scheduled", "due"].includes(token(item.status || "scheduled")))) },
    { key: "country_unknown", label: "Country needed", description: "Ask naturally before using regional pricing.", items: leadRows.filter((row) => row.country === "Country not known") },
    { key: "enrolled", label: "Enrolled", description: "Converted leads moved to student support.", items: leadRows.filter((row) => row.paid) },
  ].map((view) => ({ ...view, count: view.items.length, items: view.items.slice(0, 50) }));

  const responseTimes = leadRows.map((row) => row.first_response_minutes).filter((value) => value !== null);
  const callQueue = array(input.callQueue);
  const callLogs = array(input.callLogs);
  const aiLearning = array(input.aiLearning);
  const visibleLeadIds = new Set(leads.map((lead) => clean(lead.id || lead.lead_id)));
  const seenAiMessages = new Set();
  const aiMessages = messages.filter((message) => {
    if (!visibleLeadIds.has(leadId(message)) || !isAcceptedAiReply(message)) return false;
    const identity = clean(message.provider_message_id || message.whatsapp_message_id || message.message_id || message.id)
      || `${recordTime(message)}:${messageText(message)}`;
    const key = `${leadId(message)}:${identity}`;
    if (seenAiMessages.has(key)) return false;
    seenAiMessages.add(key);
    return true;
  });
  const handoffs = array(input.handoffs);
  const attribution = groupAttribution({ leads, payments, adPerformance: array(input.adPerformance) });
  const totalRevenue = attribution.reduce((sum, row) => sum + row.revenue_usd, 0);
  const totalSpend = attribution.reduce((sum, row) => sum + row.spend_usd, 0);
  const openKnowledgeGaps = aiLearning.filter((item) => ["new", "needs_review", "open"].includes(token(item.status || "new")));
  const recurring = input.recurring || {};

  return {
    generated_at: now.toISOString(),
    strategy: {
      name: "NextGen Revenue Journey",
      promise: "Every ad lead is guided from first contact to a real programme experience, then to enrollment or an honest stop decision.",
      stages: ["Captured", "Conversation", "Qualified", "Value explained", "Experience offered", "Experience completed", "Close", "Enrolled"],
    },
    summary: {
      total_leads: leadRows.length,
      waiting_for_reply: leadRows.filter((row) => row.reply_outstanding).length,
      sla_overdue: leadRows.filter((row) => row.sla_overdue).length,
      hot_leads: leadRows.filter((row) => row.score >= 50 && !row.paid).length,
      unassigned_leads: leadRows.filter((row) => !row.owner_id).length,
      payment_rescue: leadRows.filter((row) => row.payment_rescue).length,
      enrolled: leadRows.filter((row) => row.paid).length,
      gross_revenue_usd: Number(totalRevenue.toFixed(2)),
      ad_spend_usd: Number(totalSpend.toFixed(2)),
      roas: totalSpend ? Number((totalRevenue / totalSpend).toFixed(2)) : 0,
      average_first_response_minutes: Number(average(responseTimes).toFixed(1)),
      recurring_subscribers: Number(recurring.recurring_subscribers || 0),
      monthly_recurring_revenue_cents: Number(recurring.monthly_recurring_revenue_cents || 0),
      remaining_recurring_commitment_cents: Number(recurring.estimated_remaining_recurring_commitment_cents || 0),
    },
    smart_views: smartViews,
    leads: leadRows,
    attribution,
    ai: {
      conversations_handled: new Set(aiMessages.map(leadId).filter(Boolean)).size,
      ai_messages: aiMessages.length,
      appointments_booked: appointments.filter((item) => ["scheduled", "booked", "confirmed"].includes(token(item.status))).length,
      followups_scheduled: futureFollowups.filter((item) => ["scheduled", "due"].includes(token(item.status || "scheduled"))).length,
      human_handovers: handoffs.length,
      open_knowledge_gaps: openKnowledgeGaps.length,
      knowledge_gaps: openKnowledgeGaps.slice(0, 50),
      average_response_minutes: Number(average(responseTimes).toFixed(1)),
      outcomes_note: "Ayla is measured by outcomes and knowledge gaps; no decorative training percentage is used.",
    },
    calling: {
      provider: input.callProvider?.provider || "not_configured",
      configured: input.callProvider?.configured === true,
      inbound_number: input.callProvider?.inbound_number || "",
      whatsapp: input.callProvider?.whatsapp || null,
      queue_open: callQueue.filter((item) => !["closed", "converted", "not_interested"].includes(token(item.status))).length,
      calls_logged: callLogs.length,
      answered: callLogs.filter((item) => ["answered", "completed", "connected"].includes(token(item.outcome || item.status))).length,
      voicemail: callLogs.filter((item) => token(item.outcome || item.status) === "voicemail").length,
      no_answer: callLogs.filter((item) => ["no_answer", "busy"].includes(token(item.outcome || item.status))).length,
      next_step: input.callProvider?.whatsapp?.inbound_ready === true
        ? "Inbound WhatsApp AI calling is ready for one controlled student-initiated test call."
        : input.callProvider?.whatsapp?.messaging_configured === true
          ? "WhatsApp messaging is live. Finish the calls webhook and realtime media bridge before Ayla answers a call."
          : input.callProvider?.configured === true
            ? "Calling is ready for provider verification and a controlled test call."
            : "Connect a compliant calling path before enabling any real call.",
    },
  };
}
