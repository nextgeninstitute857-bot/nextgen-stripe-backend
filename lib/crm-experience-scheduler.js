import { randomUUID } from "node:crypto";
import { experienceTemplateMessage } from "./crm-experience-template.js";
import { experienceFollowupEligibility, experienceDeliveryAccepted, validateExperienceCheckin } from "./crm-experience-followup.js";

const fingerprint = (context) => JSON.stringify([
  context.latestInbound?.id, context.latestInbound?.provider_message_id, context.latestInbound?.created_at,
  context.latestOutbound?.id, context.latestOutbound?.created_at, context.channel,
]);

// The AI call happens outside the database transaction. Reserve durably before
// the external send, then recheck inside an atomic mutation. A process crash or
// ambiguous delivery is held for review, never blindly sent a second time.
export async function runExperienceCheckin({ leadId, read, mutate, context, generate, send, review, lock, unlock, now = Date.now }) {
  const eligibility = (ctx, reservationId = null) => ctx.blocked
    ? { ok: false, reason: ctx.blocked }
    : experienceFollowupEligibility({ ...ctx, now: now(), reservationId });
  const initial = context(await read(), leadId);
  const decision = eligibility(initial);
  if (!decision.ok) {
    if (["experience_template_required", "needs_delivery_review", "delivery_reserved_needs_review"].includes(decision.reason) && decision.item?.review_reason !== decision.reason) {
      await mutate(async (db) => {
        const current = context(db, leadId);
        const check = eligibility(current);
        if (check.reason !== decision.reason || !check.item) return;
        if (check.reason === "experience_template_required") check.item.status = "template_required";
        review(db, current.lead, check.item, check.reason);
      });
    }
    return { lead_id: leadId, sent: false, reason: decision.reason };
  }
  const held = lock(initial.lead, decision.item);
  if (!held.locked) return { lead_id: leadId, sent: false, reason: "conversation_busy" };
  try {
    let reply;
    let template = null;
    try {
      if (decision.mode === "template") {
        template = experienceTemplateMessage(initial.lead, decision.item);
        reply = template.text;
      } else {
        reply = await generate(initial, decision.item);
        if (!validateExperienceCheckin(reply, decision.item)) throw new Error("Check-in draft failed quality validation");
      }
    } catch (error) {
      await mutate(async (db) => {
        const current = context(db, leadId);
        const check = eligibility(current);
        if (!check.ok || check.item.id !== decision.item.id) return;
        check.item.last_attempt_at = new Date(now()).toISOString();
        check.item.attempt_count = Number(check.item.attempt_count || 0) + 1;
        check.item.last_error = String(error.message || "AI draft unavailable").slice(0, 240);
        review(db, current.lead, check.item, "experience_draft_needs_review");
      });
      return { lead_id: leadId, sent: false, reason: "experience_draft_needs_review" };
    }
    const reservationId = randomUUID();
    const reserved = await mutate(async (db) => {
      const current = context(db, leadId);
      const check = eligibility(current);
      if (!check.ok || check.mode !== decision.mode || check.template_id !== decision.template_id || check.item.id !== decision.item.id || fingerprint(current) !== fingerprint(initial)) return false;
      check.item.reservation_id = reservationId;
      check.item.reserved_at = new Date(now()).toISOString();
      check.item.draft_reply = reply;
      return true;
    });
    if (!reserved) return { lead_id: leadId, sent: false, reason: "conversation_changed_before_checkin" };
    return await mutate(async (db) => {
      const current = context(db, leadId);
      const item = current.lead?.ayla_experience_followups?.find((row) => row.id === decision.item.id);
      if (item?.reservation_id !== reservationId) return { lead_id: leadId, sent: false, reason: "reservation_changed" };
      const check = eligibility(current, reservationId);
      if (!check.ok || check.mode !== decision.mode || check.template_id !== decision.template_id || check.item.id !== item.id || fingerprint(current) !== fingerprint(initial)) {
        delete item.reservation_id;
        delete item.reserved_at;
        return { lead_id: leadId, sent: false, reason: "conversation_changed_before_checkin" };
      }
      item.last_attempt_at = new Date(now()).toISOString();
      item.attempt_count = Number(item.attempt_count || 0) + 1;
      let result;
      try {
        result = await send({ db, lead: current.lead, item, reply, template });
      } catch (error) {
        result = { status: "delivery_uncertain", error: String(error.message || "Delivery uncertain").slice(0, 240) };
      }
      const accepted = experienceDeliveryAccepted(result);
      item.status = accepted ? "checkin_sent" : "needs_delivery_review";
      item.delivery_status = result?.status || "unknown";
      item.message_id = result?.log?.id || null;
      item.provider_message_id = result?.log?.provider_message_id || null;
      item.updated_at = new Date(now()).toISOString();
      delete item.reservation_id;
      delete item.reserved_at;
      if (accepted) {
        item.checkin_sent_at = item.updated_at;
        // All links in one earlier conversation are one experience batch.
        for (const other of current.lead.ayla_experience_followups) {
          if (other.id !== item.id && ["pending", "template_required"].includes(other.status)
            && Date.parse(other.shared_at) <= Date.parse(item.shared_at)) {
            other.status = "superseded";
            other.updated_at = item.updated_at;
          }
        }
      } else {
        item.last_error = String(result?.error || result?.reason || "Provider did not confirm sending").slice(0, 240);
        review(db, current.lead, item, "experience_delivery_needs_review");
      }
      return { lead_id: leadId, item_id: item.id, sent: accepted, reason: accepted ? "checkin_sent" : "experience_delivery_needs_review" };
    });
  } finally {
    unlock(held.key);
  }
}
