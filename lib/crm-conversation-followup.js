const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const time = (value) => Date.parse(value || "") || 0;
const text = (message = {}) => clean(message?.message_text || message?.text || message?.body || message?.message);
const id = (message = {}) => clean(message?.id || message?.provider_message_id || message?.message_id);

// This validates permission for an external side effect; it does not write
// conversational copy or route ordinary replies by keywords.
export function hasExplicitPaymentCommitment(value) {
  const words = clean(value).toLowerCase();
  if (!words || /\?|\b(?:not|can't|cannot|won't|don't|if|maybe|might|already paid|have paid)\b/.test(words)) return false;
  return /\b(?:i(?:['’]ll| will| am ready to|'m ready to)|ready to|let me|i want to)\b.{0,55}\b(?:pay|enrol(?:l)?|purchase|buy)\b/.test(words);
}

export function recordAylaPaymentFollowup({ lead, decision = {}, inbound = {}, studentText = "", now = new Date().toISOString() }) {
  const item = decision.payment_followup || {};
  if (!item.disposition || item.disposition === "none") return false;
  const evidence = clean(item.evidence);
  if (!evidence || !clean(studentText || text(inbound)).includes(evidence) || !id(inbound)) return false;
  if (item.disposition === "payment_ready" && !hasExplicitPaymentCommitment(evidence)) return false;
  if (!["payment_ready", "requested_later", "cancelled"].includes(item.disposition)) return false;
  lead.ayla_payment_followup = {
    source: "student_conversation",
    status: item.disposition === "payment_ready" ? "pending" : item.disposition === "requested_later" ? "deferred" : "cancelled",
    evidence,
    inbound_id: id(inbound),
    requested_time: clean(item.requested_time) || null,
    confirmed_at: now,
  };
  return true;
}

export function aylaPaymentFollowupEligibility({ lead = {}, latestInbound = {}, latestOutbound = {}, futureFollowups = [], now = Date.now(), waitHours = 4.5 }) {
  const permission = lead.ayla_payment_followup;
  if (!permission || permission.source !== "student_conversation" || permission.status !== "pending" || !hasExplicitPaymentCommitment(permission.evidence)) {
    return { ok: false, reason: "no_explicit_payment_commitment" };
  }
  if (permission.sent_at) return { ok: false, reason: "payment_followup_already_sent" };
  // Reconsider after any later student turn rather than chase a stale promise.
  if (id(latestInbound) !== permission.inbound_id) return { ok: false, reason: "payment_context_changed" };
  if (permission.requested_time || futureFollowups.some((item) => String(item.lead_id) === String(lead.id) && ["scheduled", "due"].includes(item.status || "scheduled"))) {
    return { ok: false, reason: "respect_requested_followup_time" };
  }
  if ([lead.payment_promise_date, lead.availability_promised_at, lead.next_follow_up_at].some((value) => time(value) > now)) {
    return { ok: false, reason: "respect_requested_followup_time" };
  }
  const inboundAt = time(latestInbound?.created_at || latestInbound?.received_at || latestInbound?.timestamp);
  const outboundAt = time(latestOutbound?.created_at || latestOutbound?.sent_at || latestOutbound?.timestamp);
  if (!inboundAt || outboundAt <= inboundAt) return { ok: false, reason: "student_message_waiting_for_reply" };
  const due = Math.max(time(permission.confirmed_at), outboundAt) + Math.max(4, Math.min(5, waitHours)) * 3600000;
  if (now < due) return { ok: false, reason: "waiting_4_to_5_hours", wait_ms: due - now };
  return { ok: true, due_at: new Date(due).toISOString() };
}
