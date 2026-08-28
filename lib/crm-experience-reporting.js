import { EXPERIENCE_TEMPLATE } from "./crm-experience-template.js";
const reasons = {
  ready: "Ready for the next automatic check",
  not_due: "Waiting until the six-hour check-in time",
  experience_followup_disabled: "Experience follow-ups are switched off",
  experience_template_required: "Waiting for an approved experience check-in template (outside 24 hours)",
  experience_template_disabled: "Outside-24-hour check-ins are not activated",
  experience_template_owner_approval_required: "Waiting for your approval of this exact check-in wording",
  experience_template_approval_stale: "Fresh Meta approval status is needed before sending",
  experience_followup_consent_required: "Follow-up permission has not been recorded",
  experience_marketing_number_review: "Numbering region needs review: Marketing templates cannot go to US numbers",
  experience_phone_unverified: "A valid international WhatsApp number is needed",
  contact_stopped: "Student opted out or is not interested",
  suppressed: "Contact is on the do-not-contact list",
  human_takeover: "You or your team are handling this conversation",
  already_enrolled: "Already enrolled or paid — no sales check-in",
  mentor_handoff_active: "Mentor handoff is in progress",
  payment_followup_has_priority: "Payment follow-up takes priority",
  respect_requested_followup_time: "Respecting the student's requested date or time",
  no_student_conversation: "No verified incoming student message",
  student_replied_since_share: "Ayla must handle the student's newer reply first",
  student_waiting_for_reply: "The student's message needs an answer first",
  recent_outbound_cooldown: "A message was sent recently — avoiding another interruption",
  experience_frequency_cap: "A check-in was already sent within 48 hours",
  experience_batch_already_checked: "This set of links has already had its check-in",
  experience_checkin_expired: "Too old to chase automatically — review if needed",
  attempt_cooldown: "Waiting before retrying the draft",
  needs_delivery_review: "Needs review — no automatic repeat send",
  delivery_reserved_needs_review: "Earlier delivery may be incomplete — review before resending",
  channel_not_enabled: "Experience check-ins currently support WhatsApp only",
  no_pending_experience: "No check-in is waiting",
  ai_unavailable: "AI connection is unavailable",
  provider_blocked: "WhatsApp delivery needs attention",
  heartbeat_disabled: "The background worker is switched off",
};

export function experienceQueueRows({ leads = [], logs = [], context, eligibility, blocked = null }) {
  const byId = new Map(logs.filter((log) => log.id).map((log) => [String(log.id), log]));
  const byProviderId = new Map(logs.filter((log) => log.provider_message_id).map((log) => [String(log.provider_message_id), log]));
  return leads.map((lead) => {
    const ctx = context(lead.id);
    const decision = ctx.blocked || blocked ? { ok: false, reason: ctx.blocked || blocked } : eligibility(ctx);
    return {
      lead_id: lead.id, name: lead.name || lead.full_name || "Name not yet confirmed",
      eligible: Boolean(decision.ok), reason: decision.reason,
      reason_label: reasons[decision.reason] || "Review the check-in status",
      experiences: (lead.ayla_experience_followups || []).map((item) => {
        const log = byId.get(String(item.message_id)) || byProviderId.get(String(item.provider_message_id));
        const providerStatus = String(log?.status || "").toLowerCase();
        const delivery = ["read", "delivered", "failed", "sent"].includes(providerStatus) ? providerStatus : item.checkin_sent_at ? "accepted" : "not_sent";
        return { id: item.id, kind: item.kind, title: item.title, shared_at: item.shared_at, due_at: item.due_at,
          status: item.status, outcome: item.outcome, feedback: item.feedback, evidence_source: item.evidence_source,
          checkin_sent_at: item.checkin_sent_at || null, requested_time: item.requested_time || null,
          delivery, delivered_at: log?.delivered_at || null, read_at: log?.read_at || null,
        };
      }),
    };
  });
}

export const experienceTemplateProposal = {
  ...EXPERIENCE_TEMPLATE, status: "owner_approval_required", enabled: false,
};
