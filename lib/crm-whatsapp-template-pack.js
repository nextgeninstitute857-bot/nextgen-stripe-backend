const PACK_VERSION = "2026-08-23-six-template-pack-v1";

export const NEXTGEN_WHATSAPP_TEMPLATE_PACK = Object.freeze([
  {
    key: "nextgen_warm_welcome",
    name: "Warm welcome",
    meta_category: "MARKETING",
    template_purpose: "first_message",
    campaign_slot: "first_message",
    body: "Hi Dr. {{name}} 👋 Ayla here from NextGen! Thanks for reaching out about {{exam}}. Our programme combines live teaching, recordings, QBank practice, weak-area tracking, adaptive flashcards and mentor support in one organised system. I’d love you to experience it yourself—start your 7-day demo below.",
    variables: ["name", "exam"],
    button: {
      type: "URL",
      text: "Start 7-Day Demo",
      url: "https://nextgenusmle.live/demo",
    },
  },
  {
    key: "nextgen_live_session_invite",
    name: "Live-session invitation",
    meta_category: "MARKETING",
    template_purpose: "live_session_invitation",
    campaign_slot: "daily_live_session_invite",
    body: "Hi Dr. {{name}} 👋 Today’s {{topic}} live class starts at {{time}}. It’s a great opportunity to experience our teaching quality and organised programme. We’d love to have you with us!",
    variables: ["name", "topic", "time"],
    button: {
      type: "URL",
      text: "Join Live Session",
      url: "https://nextgenusmle.live/student/live-sessions",
    },
  },
  {
    key: "nextgen_live_five_minute_reminder",
    name: "Five-minute reminder",
    meta_category: "UTILITY",
    template_purpose: "live_session_reminder",
    campaign_slot: "five_minute_reminder",
    body: "Dr. {{name}}, we’re going live in five minutes! ⏰ Today’s topic is {{topic}}. Grab your notes and join us here.",
    variables: ["name", "topic"],
    button: {
      type: "URL",
      text: "Join Now",
      url: "https://nextgenusmle.live/student/live-sessions",
    },
  },
  {
    key: "nextgen_recording_notes_ready",
    name: "Recording and notes ready",
    meta_category: "UTILITY",
    template_purpose: "recording_followup",
    campaign_slot: "recording_ready",
    body: "Hi Dr. {{name}} 👋 Missed the live class? No worries—your {{full_session_name}} recording and session notes are ready. Watch it at your own pace, then continue with your roadmap.",
    variables: ["name", "full_session_name"],
    button: {
      type: "URL",
      text: "Watch Recording",
      url: "https://nextgenusmle.live/student/recordings",
    },
  },
  {
    key: "nextgen_payment_ready_followup",
    name: "Payment-ready follow-up",
    meta_category: "MARKETING",
    template_purpose: "payment_ready_followup",
    campaign_slot: "payment_ready_followup",
    body: "Hi Dr. {{name}} 👋 You asked me to check back with you about enrolling in {{programme}}. I’m here now—would you like help completing your enrollment or answering one final question?",
    variables: ["name", "programme"],
    eligibility_rule: "Only send after the lead explicitly says they are interested in paying or asks for an enrollment follow-up.",
  },
  {
    key: "nextgen_mentor_meeting_confirmation",
    name: "Mentor meeting confirmation",
    meta_category: "UTILITY",
    template_purpose: "mentor_booking",
    campaign_slot: "mentor_meeting_confirmation",
    body: "You’re booked! 🎉 Hi Dr. {{name}}, your NextGen mentor call is confirmed for {{date}} at {{time}}. We look forward to speaking with you.",
    variables: ["name", "date", "time"],
    button: {
      type: "URL",
      text: "Join Meeting",
      url: "https://meet.google.com/{{meeting_code}}",
      dynamic: true,
      variable: "meeting_code",
    },
  },
]);

export const OBSOLETE_NEXTGEN_WHATSAPP_TEMPLATE_KEYS = Object.freeze([
  "meta_ad_first_message",
  "meta_first_message",
  "first_message_intro",
  "greeting_exam_type_question",
  "exam_type_question",
  "sunday_first_message",
  "five_minute_reminder",
  "five_min_live_session_reminder",
  "live_session_1pm_reminder",
  "live_session_link_now",
  "daily_live_session_invite",
  "live_session_invitation",
  "next_day_missed_session",
  "sorry_you_missed_session",
  "recording_followup_after_session",
  "post_live_notes_recording_followup",
  "session_recording_video",
  "two_day_lms_demo_access",
  "demo_lms_activation_invite",
  "enrollment_help_after_interest",
  "mentor_call_offer",
  "mentor_booking",
]);

function normalizedKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function recordKeys(record = {}) {
  return [
    record.key,
    record.template_key,
    record.name,
    record.template_name,
    record.meta_template_name,
    record.whatsapp_template_name,
    record.provider_template_name,
  ].map(normalizedKey).filter(Boolean);
}

function liveTemplateMap(liveTemplates = []) {
  const map = new Map();
  for (const item of Array.isArray(liveTemplates) ? liveTemplates : []) {
    const key = normalizedKey(item?.name);
    if (key) map.set(key, item);
  }
  return map;
}

function isApprovedMetaStatus(value = "") {
  return ["approved", "active"].includes(String(value || "").trim().toLowerCase());
}

function canonicalRecord(definition, existing = null, now = new Date().toISOString()) {
  const base = existing || {};
  return {
    ...base,
    id: base.id || `nextgen-template-${definition.key}`,
    key: definition.key,
    template_key: definition.key,
    name: definition.name,
    channel: "whatsapp",
    category: definition.template_purpose,
    template_purpose: definition.template_purpose,
    campaign_slot: definition.campaign_slot,
    subject: "",
    body: definition.body,
    variables: [...definition.variables],
    language: "English (US)",
    language_code: "en_US",
    meta_language: "en_US",
    whatsapp_language: "en_US",
    provider_language_code: "en_US",
    template_name: definition.key,
    meta_template_name: definition.key,
    whatsapp_template_name: definition.key,
    provider_template_name: definition.key,
    meta_category: definition.meta_category,
    whatsapp_category: definition.meta_category,
    provider_category: definition.meta_category,
    button: definition.button ? { ...definition.button } : null,
    eligibility_rule: definition.eligibility_rule || "",
    active: true,
    ai_allowed: true,
    approval_required: true,
    managed_by: "nextgen_whatsapp_template_pack",
    template_pack_version: PACK_VERSION,
    status: base.status && base.status !== "archived" ? base.status : "draft",
    meta_status: base.meta_status || "draft",
    provider_status: base.provider_status || base.meta_status || "draft",
    meta_approved: base.meta_approved === true,
    whatsapp_approved: base.whatsapp_approved === true,
    is_meta_approved: base.is_meta_approved === true,
    created_at: base.created_at || now,
    updated_at: base.updated_at || now,
  };
}

export function reconcileNextGenWhatsAppTemplatePack(records = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const liveWasChecked = options.liveWasChecked === true;
  const liveByName = liveTemplateMap(options.liveTemplates);
  const obsolete = new Set(OBSOLETE_NEXTGEN_WHATSAPP_TEMPLATE_KEYS);
  const source = Array.isArray(records) ? records : [];
  const next = source.map((record) => ({ ...record }));
  const archived = [];

  for (const record of next) {
    const keys = recordKeys(record);
    const isObsolete = keys.some((key) => obsolete.has(key));
    const isCanonical = keys.some((key) => NEXTGEN_WHATSAPP_TEMPLATE_PACK.some((item) => item.key === key));
    if (isObsolete && !isCanonical && record.active !== false && record.status !== "archived") {
      record.active = false;
      record.status = "archived";
      record.archived_reason = "Replaced by the approved six-template NextGen WhatsApp pack.";
      record.archived_at = now;
      record.updated_at = now;
      archived.push(record.id || record.key || record.name);
    }
  }

  for (const definition of NEXTGEN_WHATSAPP_TEMPLATE_PACK) {
    const index = next.findIndex((record) => recordKeys(record).includes(definition.key));
    const merged = canonicalRecord(definition, index >= 0 ? next[index] : null, now);
    const live = liveByName.get(definition.key);

    if (liveWasChecked) {
      const liveStatus = String(live?.status || "").trim().toLowerCase();
      const approved = Boolean(live && isApprovedMetaStatus(liveStatus));
      merged.meta_status = live ? liveStatus || "unknown" : "draft";
      merged.provider_status = merged.meta_status;
      merged.meta_approved = approved;
      merged.whatsapp_approved = approved;
      merged.is_meta_approved = approved;
      merged.provider_template_id = live?.id || "";
      merged.meta_template_id = live?.id || "";
      merged.meta_last_synced_at = now;
    }

    if (index >= 0) next[index] = merged;
    else next.unshift(merged);
  }

  return {
    templates: next,
    canonical: NEXTGEN_WHATSAPP_TEMPLATE_PACK.map((item) => item.key),
    archived,
    liveApprovedCount: NEXTGEN_WHATSAPP_TEMPLATE_PACK.filter((item) => {
      const live = liveByName.get(item.key);
      return live && isApprovedMetaStatus(live.status);
    }).length,
  };
}

export function normalizeMetaTemplateInventory(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ""),
    name: String(item?.name || ""),
    status: String(item?.status || "UNKNOWN").toUpperCase(),
    category: String(item?.category || "UNKNOWN").toUpperCase(),
    language: String(item?.language || ""),
  }));
}

export const NEXTGEN_WHATSAPP_TEMPLATE_PACK_VERSION = PACK_VERSION;
