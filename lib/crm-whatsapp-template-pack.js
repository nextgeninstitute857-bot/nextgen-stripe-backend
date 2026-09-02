const PACK_VERSION = "2026-09-01-live-recording-utility-v5";

export const NEXTGEN_WHATSAPP_TEMPLATE_PACK = Object.freeze([
  {
    key: "nextgen_warm_welcome",
    name: "Warm welcome",
    meta_category: "MARKETING",
    template_purpose: "first_message",
    campaign_slot: "fallback_first_outreach",
    body: "Hi Dr. {{name}} 👋 Ayla here from NextGen! Thanks for reaching out about {{exam}}. Our programme combines live teaching, recordings, QBank practice, weak-area tracking, adaptive flashcards and mentor support in one organised system. I’d love you to experience it yourself—start your 7-day demo below.",
    variables: ["name", "exam"],
    fallback_only: true,
    normal_sequence: false,
    eligibility_rule: "Only for an explicitly queued lead-form or imported contact with no inbound WhatsApp conversation. Never use inside an open customer-service window.",
    button: {
      type: "URL",
      text: "Start 7-Day Demo",
      url: "https://nextgenusmle.live/demo",
    },
  },
  {
    key: "nextgen_live_session_invite",
    provider_template_name: "nextgen_live_session_invite_v2",
    name: "Live-session invitation",
    meta_category: "MARKETING",
    template_purpose: "live_session_invitation",
    campaign_slot: "daily_live_session_invite",
    body: "Hi Dr. {{name}}, today’s live class is {{topic}} at {{time}}. You’re welcome to join and see how the session is taught. I’ll remind you again five minutes before we begin.",
    variables: ["name", "topic", "time"],
    button: {
      type: "URL",
      text: "Join Live Session",
      url: "https://nextgenusmle.live/student/live-sessions",
    },
  },
  {
    key: "nextgen_live_five_minute_reminder",
    provider_template_name: "nextgen_live_five_minute_reminder_v2",
    name: "Five-minute reminder",
    meta_category: "UTILITY",
    template_purpose: "live_session_reminder",
    campaign_slot: "five_minute_reminder",
    body: "Dr. {{name}}, we’re starting in five minutes ⏰ Today’s session is {{topic}}. Please be ready—I’ll send you the direct class link when the session begins.",
    variables: ["name", "topic"],
    button: {
      type: "URL",
      text: "Open Live Sessions",
      url: "https://nextgenusmle.live/student/live-sessions",
    },
  },
  {
    key: "nextgen_live_session_link",
    provider_template_name: "nextgen_live_session_link_v3",
    name: "Live-session link",
    meta_category: "UTILITY",
    template_purpose: "session_link",
    campaign_slot: "session_link",
    body: "Dr. {{name}}, your scheduled NextGen class {{topic}} is starting now. Join using this class link: {{live_session_link}}. Please use it when class begins.",
    variables: ["name", "topic", "live_session_link"],
  },
  {
    key: "nextgen_class_recording_link",
    provider_template_name: "nextgen_class_recording_link_v2",
    name: "Class recording link",
    meta_category: "UTILITY",
    template_purpose: "recording_followup",
    campaign_slot: "recording_link",
    body: "Dr. {{name}}, the recording and notes for {{full_session_name}} are now available. Open the recording here: {{recording_link}}. You can review it whenever you are ready.",
    variables: ["name", "full_session_name", "recording_link"],
  },
  {
    key: "nextgen_recording_notes_ready",
    provider_template_name: "nextgen_recording_notes_ready_v2",
    name: "Recording and notes ready",
    meta_category: "UTILITY",
    template_purpose: "recording_followup",
    campaign_slot: "recording_ready",
    body: "Dr. {{name}}, the notes for the following session are now available:\n\n{{full_session_name}}\n\nYou can open the recording and notes whenever you’re ready.",
    variables: ["name", "full_session_name"],
    button: {
      type: "URL",
      text: "Open Recording & Notes",
      url: "https://nextgenusmle.live/student/recordings",
    },
  },
  {
    key: "nextgen_payment_ready_followup",
    provider_template_name: "nextgen_payment_ready_followup_v2",
    name: "Payment-ready follow-up",
    meta_category: "MARKETING",
    template_purpose: "payment_ready_followup",
    campaign_slot: "payment_ready_followup",
    body: "Hi Dr. {{name}}, you asked me to check back with you about joining {{programme}}. Would you like me to help you enroll, or is there anything you would like to ask first?",
    variables: ["name", "programme"],
    eligibility_rule: "Only send after the lead explicitly says they are interested in paying or asks for an enrollment follow-up.",
  },
  {
    key: "nextgen_mentor_meeting_confirmation",
    provider_template_name: "nextgen_mentor_meeting_confirmation_v2",
    name: "Mentor meeting confirmation",
    meta_category: "UTILITY",
    template_purpose: "mentor_booking",
    campaign_slot: "mentor_meeting_confirmation",
    body: "You’re booked 🎉 Dr. {{name}}, your call with a NextGen mentor is confirmed for {{date}} at {{time}}. You can join the call using the button below.",
    variables: ["name", "date", "time"],
    button: {
      type: "URL",
      text: "Join Mentor Call",
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

const NEXTGEN_WHATSAPP_TEMPLATE_EXAMPLES = Object.freeze({
  name: "Sarah",
  exam: "USMLE Step 1",
  topic: "Central Nervous System — Day 7",
  time: "12:00 PM Eastern",
  live_session_link: "https://example.com/live-class",
  full_session_name: "Central Nervous System — Day 7 — Neurology / CNS",
  recording_link: "https://example.com/class-recording",
  programme: "120-Day USMLE Step 1 Program",
  date: "September 2, 2026",
  meeting_code: "abc-defg-hij",
});

export const NEXTGEN_WHATSAPP_ACTIVE_TEMPLATE_KEYS = Object.freeze(
  NEXTGEN_WHATSAPP_TEMPLATE_PACK
    .filter((item) => item.normal_sequence !== false && item.fallback_only !== true)
    .map((item) => item.key),
);

export function nextGenWhatsAppProviderTemplateName(definition = {}) {
  return String(definition.provider_template_name || definition.meta_template_name || definition.key || "").trim();
}

export function buildNextGenWhatsAppMetaTemplateSubmission(definition = {}) {
  const variables = Array.isArray(definition.variables) ? definition.variables : [];
  const variablePositions = new Map(variables.map((key, index) => [String(key), index + 1]));
  const body = String(definition.body || "").replace(/{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (_match, key) => {
    const position = variablePositions.get(String(key));
    if (!position) throw new Error(`Missing WhatsApp template variable order for ${key}.`);
    return `{{${position}}}`;
  });
  const bodyComponent = { type: "BODY", text: body };
  if (variables.length) {
    bodyComponent.example = {
      body_text: [variables.map((key) => NEXTGEN_WHATSAPP_TEMPLATE_EXAMPLES[key] || `Example ${key}`)],
    };
  }

  const components = [bodyComponent];
  if (definition.button?.type === "URL" && definition.button?.url && definition.button?.text) {
    const dynamicVariable = String(definition.button.variable || "").trim();
    const button = {
      type: "URL",
      text: String(definition.button.text),
      url: String(definition.button.url),
    };
    if (dynamicVariable) {
      button.url = button.url.replace(new RegExp(`{{\\s*${dynamicVariable}\\s*}}`, "g"), "{{1}}");
      button.example = [NEXTGEN_WHATSAPP_TEMPLATE_EXAMPLES[dynamicVariable] || "example-value"];
    }
    components.push({ type: "BUTTONS", buttons: [button] });
  }

  return {
    name: nextGenWhatsAppProviderTemplateName(definition),
    language: String(definition.meta_language || definition.language_code || "en"),
    category: String(definition.meta_category || "MARKETING").toUpperCase(),
    components,
  };
}

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
  const providerTemplateName = nextGenWhatsAppProviderTemplateName(definition);
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
    language: "English",
    language_code: "en",
    meta_language: "en",
    whatsapp_language: "en",
    provider_language_code: "en",
    template_name: providerTemplateName,
    meta_template_name: providerTemplateName,
    whatsapp_template_name: providerTemplateName,
    provider_template_name: providerTemplateName,
    meta_category: definition.meta_category,
    whatsapp_category: definition.meta_category,
    provider_category: definition.meta_category,
    button: definition.button ? { ...definition.button } : null,
    eligibility_rule: definition.eligibility_rule || "",
    fallback_only: definition.fallback_only === true,
    normal_sequence: definition.normal_sequence !== false,
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
      record.archived_reason = "Replaced by the managed NextGen WhatsApp template pack.";
      record.archived_at = now;
      record.updated_at = now;
      archived.push(record.id || record.key || record.name);
    }
  }

  for (const definition of NEXTGEN_WHATSAPP_TEMPLATE_PACK) {
    const index = next.findIndex((record) => recordKeys(record).includes(definition.key));
    const merged = canonicalRecord(definition, index >= 0 ? next[index] : null, now);
    const live = liveByName.get(nextGenWhatsAppProviderTemplateName(definition));

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
      const live = liveByName.get(nextGenWhatsAppProviderTemplateName(item));
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
    ...(Array.isArray(item?.components) ? { components: item.components.map(component => ({ type: String(component.type || ""), ...(component.text ? { text: String(component.text) } : {}) })) } : {}),
  }));
}

export const NEXTGEN_WHATSAPP_TEMPLATE_PACK_VERSION = PACK_VERSION;
