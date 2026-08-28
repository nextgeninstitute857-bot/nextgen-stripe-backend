export const EXPERIENCE_TEMPLATE = Object.freeze({
  name: "nextgen_experience_checkin", language: "en_US", category: "MARKETING",
  body: "Hi {{1}} 👋 Ayla from NextGen here. Have you had a chance to explore {{2}}? I'd love to hear how you found it and help with your next step. Reply STOP if you don't want programme follow-ups.",
});

export function experienceTemplateGate({ enabled = false, ownerApproved = false, template, checkedAt, lead = {}, now = Date.now() } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!ownerApproved) return fail("experience_template_owner_approval_required");
  if (!enabled) return fail("experience_template_disabled");
  const checked = Date.parse(checkedAt);
  if (!Number.isFinite(checked) || checked > now + 30000 || now - checked > 5 * 60000) return fail("experience_template_approval_stale");
  if (!template?.id || template.name !== EXPERIENCE_TEMPLATE.name || template.language !== EXPERIENCE_TEMPLATE.language
    || template.status !== "APPROVED" || template.category !== "MARKETING"
    || template.components?.find(c => c.type === "BODY")?.text !== EXPERIENCE_TEMPLATE.body) return fail("experience_template_required");
  const consent = lead.whatsapp_followup_consent;
  if (consent?.status !== "granted" || consent.scope !== "programme_experience" || !consent.source || !consent.evidence
    || !Number.isFinite(Date.parse(consent.recorded_at)) || Date.parse(consent.recorded_at) > now || consent.revoked_at) return fail("experience_followup_consent_required");
  const phone = String(lead.whatsapp || lead.whatsapp_number || lead.phone || lead.mobile || "").replace(/[\s().-]/g, "");
  if (!/^\+?[2-9]\d{7,14}$/.test(phone)) {
    // +1 includes Canada and other NANP regions, not just the US. Until an
    // authoritative numbering-region check exists, hold it for review. Never
    // treat campaign country or the student's residence as numbering evidence.
    return fail(/^\+?1/.test(phone) ? "experience_marketing_number_review" : "experience_phone_unverified");
  }
  return { ok: true, reason: "ready", template_id: template.id };
}

export function experienceTemplateMessage(lead = {}, item = {}) {
  const name = String(lead.ayla_conversation_state?.facts?.name || lead.name || "there").replace(/[\r\n{}]/g, " ").trim().slice(0, 70) || "there";
  const title = String(item.title || "").trim();
  if (!title || title.length > 180 || /https?:|www\.|[\r\n{}]/i.test(title)) throw new Error("The resource title needs review before template delivery.");
  return { templateName: EXPERIENCE_TEMPLATE.name, languageCode: EXPERIENCE_TEMPLATE.language,
    text: EXPERIENCE_TEMPLATE.body.replace("{{1}}", () => name).replace("{{2}}", () => title),
    components: [{ type: "body", parameters: [{ type: "text", text: name }, { type: "text", text: title }] }],
  };
}

export function experienceTemplateSubmission() {
  return { name: EXPERIENCE_TEMPLATE.name, language: EXPERIENCE_TEMPLATE.language, category: EXPERIENCE_TEMPLATE.category,
    components: [{ type: "BODY", text: EXPERIENCE_TEMPLATE.body, example: { body_text: [["Sarah", "Central Nervous System — Day 2 recording"]] } }],
  };
}
