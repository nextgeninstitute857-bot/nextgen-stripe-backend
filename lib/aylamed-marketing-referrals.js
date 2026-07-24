const EVIDENCE_KINDS = new Set([
  "server_verified_diagnostic",
  "provisional_self_report",
  "discovery_start",
  "diagnostic_pending",
]);

const REWARD_UNITS = new Set([
  "manual",
  "bonus_days",
  "account_credit",
  "percentage_discount",
  "fixed_discount",
  "points",
]);

const CAMPAIGN_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const MARKETING_CHANNELS = new Set(["readiness_card", "whatsapp", "referral_link"]);
const ATTRIBUTION_STATUSES = new Set(["attributed", "diagnostic_completed", "paid", "blocked", "cancelled"]);
const REWARD_STATUSES = new Set([
  "pending_hold",
  "ready_for_fulfillment",
  "fulfilled",
  "cancelled",
  "manual_review",
]);

export function aylaMarketingAdminOptions() {
  return {
    campaign_statuses: [
      { id: "draft", label: "Draft" },
      { id: "active", label: "Active" },
      { id: "paused", label: "Paused" },
      { id: "archived", label: "Archived" },
    ],
    channels: [
      { id: "readiness_card", label: "Readiness card" },
      { id: "whatsapp", label: "WhatsApp" },
      { id: "referral_link", label: "Referral link" },
    ],
    reward_units: [
      { id: "manual", label: "Manual reward" },
      { id: "bonus_days", label: "Bonus access days" },
      { id: "account_credit", label: "Account credit" },
      { id: "percentage_discount", label: "Percentage discount" },
      { id: "fixed_discount", label: "Fixed discount" },
      { id: "points", label: "Points" },
    ],
  };
}

function marketingError(message, code = "INVALID_MARKETING_SETTINGS", statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function cleanText(value = "", max = 500) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, max);
}

function cleanList(value = [], max = 100) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map((item) => cleanText(item, 180)).filter(Boolean))].slice(0, max);
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function boundedMoney(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100_000_000, Math.round(parsed)));
}

function cleanUrl(value = "") {
  const text = cleanText(value, 500).replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("unsupported protocol");
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw marketingError("public_site_url must be a valid HTTP or HTTPS URL", "INVALID_MARKETING_PUBLIC_URL");
  }
}

function cleanHex(value, fallback) {
  const text = cleanText(value, 20);
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}

function normalizeRewardSide(value = {}, fallback = {}) {
  const unit = REWARD_UNITS.has(String(value.unit || fallback.unit || "").toLowerCase())
    ? String(value.unit || fallback.unit).toLowerCase()
    : "manual";
  return {
    label: cleanText(value.label ?? fallback.label, 180),
    value: boundedMoney(value.value, Number(fallback.value || 0)),
    unit,
  };
}

function normalizeRewardRule(value = {}, fallback = {}, { paid = false } = {}) {
  const minimumHoldDays = paid ? 1 : 0;
  return {
    enabled: value.enabled === true,
    hold_days: boundedInteger(
      value.hold_days ?? value.refund_hold_days,
      minimumHoldDays,
      120,
      boundedInteger(fallback.hold_days, minimumHoldDays, 120, minimumHoldDays),
    ),
    minimum_amount_cents: paid
      ? boundedMoney(value.minimum_amount_cents, Number(fallback.minimum_amount_cents || 0))
      : 0,
    referrer: normalizeRewardSide(value.referrer || {}, fallback.referrer || {}),
    referred: normalizeRewardSide(value.referred || {}, fallback.referred || {}),
  };
}

export const AYLA_MARKETING_SETTINGS_VERSION = 1;

export const DEFAULT_AYLA_MARKETING_SETTINGS = Object.freeze({
  version: AYLA_MARKETING_SETTINGS_VERSION,
  revision: 1,
  program: {
    enabled: true,
    sharing_enabled: true,
    whatsapp_enabled: true,
    referrals_enabled: true,
    program_name: "AylaMed Readiness Challenge",
  },
  sharing: {
    allow_verified_reports: true,
    allow_provisional_reports: true,
    include_verified_score: true,
    include_weak_areas: true,
    expiry_days: 30,
    max_active_links_per_student: 3,
    public_site_url: "",
    card_title: "{{exam}} Readiness Snapshot",
    card_subtitle: "A private-to-public snapshot created by the student",
    challenge_label: "Challenge your study partner",
    cta_label: "Check your own readiness",
    share_message: "I checked my {{exam}} starting readiness with AylaMed. {{evidence}} · {{readiness}}. My next focus is {{focus}}. {{cta}}: {{share_url}}",
    whatsapp_message: "I checked my {{exam}} starting readiness with AylaMed. {{evidence}} · {{readiness}}. My next focus is {{focus}}.\n\n{{challenge}}: {{share_url}}",
    card_theme: {
      background: "#F7FAFF",
      primary: "#102B4E",
      accent: "#1F8A70",
      muted: "#60758A",
    },
  },
  attribution: {
    window_days: 30,
    first_touch_only: true,
    block_self_referrals: true,
    require_verified_diagnostic: true,
    allow_demo_signup: true,
    eligible_plan_ids: [],
  },
  rewards: {
    fulfillment_mode: "manual",
    max_rewards_per_referrer_per_month: 25,
    diagnostic: {
      enabled: false,
      hold_days: 0,
      minimum_amount_cents: 0,
      referrer: { label: "Diagnostic referral reward", value: 0, unit: "manual" },
      referred: { label: "Diagnostic completion reward", value: 0, unit: "manual" },
    },
    paid: {
      enabled: false,
      hold_days: 14,
      minimum_amount_cents: 100,
      referrer: { label: "Paid referral reward", value: 0, unit: "manual" },
      referred: { label: "New-student paid reward", value: 0, unit: "manual" },
    },
  },
  updated_at: null,
  updated_by: null,
});

export function normalizeAylaMarketingSettings(value = {}, {
  current = DEFAULT_AYLA_MARKETING_SETTINGS,
  validPlanIds = null,
} = {}) {
  const base = current && typeof current === "object" ? current : DEFAULT_AYLA_MARKETING_SETTINGS;
  const programInput = value.program && typeof value.program === "object" ? value.program : {};
  const sharingInput = value.sharing && typeof value.sharing === "object" ? value.sharing : {};
  const attributionInput = value.attribution && typeof value.attribution === "object" ? value.attribution : {};
  const rewardsInput = value.rewards && typeof value.rewards === "object" ? value.rewards : {};
  const baseProgram = base.program || DEFAULT_AYLA_MARKETING_SETTINGS.program;
  const baseSharing = base.sharing || DEFAULT_AYLA_MARKETING_SETTINGS.sharing;
  const baseAttribution = base.attribution || DEFAULT_AYLA_MARKETING_SETTINGS.attribution;
  const baseRewards = base.rewards || DEFAULT_AYLA_MARKETING_SETTINGS.rewards;
  const cardThemeInput = sharingInput.card_theme && typeof sharingInput.card_theme === "object"
    ? sharingInput.card_theme
    : {};
  const baseTheme = baseSharing.card_theme || DEFAULT_AYLA_MARKETING_SETTINGS.sharing.card_theme;

  const eligiblePlanIds = cleanList(
    attributionInput.eligible_plan_ids ?? baseAttribution.eligible_plan_ids,
    100,
  );
  if (validPlanIds) {
    const allowed = new Set(cleanList(validPlanIds, 500));
    const unknown = eligiblePlanIds.filter((id) => !allowed.has(id));
    if (unknown.length) {
      throw marketingError(
        `Unknown or unavailable AylaMed marketing plan(s): ${unknown.join(", ")}`,
        "UNKNOWN_MARKETING_PLAN",
      );
    }
  }

  const next = {
    version: AYLA_MARKETING_SETTINGS_VERSION,
    revision: Math.max(1, Number(value.revision ?? base.revision ?? 1)),
    program: {
      enabled: programInput.enabled ?? baseProgram.enabled ?? true,
      sharing_enabled: programInput.sharing_enabled ?? baseProgram.sharing_enabled ?? true,
      whatsapp_enabled: programInput.whatsapp_enabled ?? baseProgram.whatsapp_enabled ?? true,
      referrals_enabled: programInput.referrals_enabled ?? baseProgram.referrals_enabled ?? true,
      program_name: cleanText(programInput.program_name ?? baseProgram.program_name, 180)
        || DEFAULT_AYLA_MARKETING_SETTINGS.program.program_name,
    },
    sharing: {
      allow_verified_reports: sharingInput.allow_verified_reports ?? baseSharing.allow_verified_reports ?? true,
      allow_provisional_reports: sharingInput.allow_provisional_reports ?? baseSharing.allow_provisional_reports ?? true,
      include_verified_score: sharingInput.include_verified_score ?? baseSharing.include_verified_score ?? true,
      include_weak_areas: sharingInput.include_weak_areas ?? baseSharing.include_weak_areas ?? true,
      expiry_days: boundedInteger(
        sharingInput.expiry_days,
        1,
        365,
        Number(baseSharing.expiry_days || DEFAULT_AYLA_MARKETING_SETTINGS.sharing.expiry_days),
      ),
      max_active_links_per_student: boundedInteger(
        sharingInput.max_active_links_per_student,
        1,
        20,
        Number(baseSharing.max_active_links_per_student || DEFAULT_AYLA_MARKETING_SETTINGS.sharing.max_active_links_per_student),
      ),
      public_site_url: sharingInput.public_site_url === undefined
        ? cleanUrl(baseSharing.public_site_url || "")
        : cleanUrl(sharingInput.public_site_url),
      card_title: cleanText(sharingInput.card_title ?? baseSharing.card_title, 220),
      card_subtitle: cleanText(sharingInput.card_subtitle ?? baseSharing.card_subtitle, 320),
      challenge_label: cleanText(sharingInput.challenge_label ?? baseSharing.challenge_label, 180),
      cta_label: cleanText(sharingInput.cta_label ?? baseSharing.cta_label, 180),
      share_message: cleanText(sharingInput.share_message ?? baseSharing.share_message, 1200),
      whatsapp_message: cleanText(sharingInput.whatsapp_message ?? baseSharing.whatsapp_message, 1600),
      card_theme: {
        background: cleanHex(cardThemeInput.background ?? baseTheme.background, DEFAULT_AYLA_MARKETING_SETTINGS.sharing.card_theme.background),
        primary: cleanHex(cardThemeInput.primary ?? baseTheme.primary, DEFAULT_AYLA_MARKETING_SETTINGS.sharing.card_theme.primary),
        accent: cleanHex(cardThemeInput.accent ?? baseTheme.accent, DEFAULT_AYLA_MARKETING_SETTINGS.sharing.card_theme.accent),
        muted: cleanHex(cardThemeInput.muted ?? baseTheme.muted, DEFAULT_AYLA_MARKETING_SETTINGS.sharing.card_theme.muted),
      },
    },
    attribution: {
      window_days: boundedInteger(
        attributionInput.window_days,
        1,
        180,
        Number(baseAttribution.window_days || DEFAULT_AYLA_MARKETING_SETTINGS.attribution.window_days),
      ),
      first_touch_only: true,
      block_self_referrals: true,
      require_verified_diagnostic: true,
      allow_demo_signup: true,
      eligible_plan_ids: eligiblePlanIds,
    },
    rewards: {
      fulfillment_mode: "manual",
      max_rewards_per_referrer_per_month: boundedInteger(
        rewardsInput.max_rewards_per_referrer_per_month,
        1,
        500,
        Number(baseRewards.max_rewards_per_referrer_per_month || DEFAULT_AYLA_MARKETING_SETTINGS.rewards.max_rewards_per_referrer_per_month),
      ),
      diagnostic: normalizeRewardRule(
        rewardsInput.diagnostic || {},
        baseRewards.diagnostic || DEFAULT_AYLA_MARKETING_SETTINGS.rewards.diagnostic,
      ),
      paid: normalizeRewardRule(
        rewardsInput.paid || {},
        baseRewards.paid || DEFAULT_AYLA_MARKETING_SETTINGS.rewards.paid,
        { paid: true },
      ),
    },
    updated_at: value.updated_at ?? base.updated_at ?? null,
    updated_by: value.updated_by ?? base.updated_by ?? null,
  };

  for (const key of ["enabled", "sharing_enabled", "whatsapp_enabled", "referrals_enabled"]) {
    next.program[key] = next.program[key] === true;
  }
  for (const key of ["allow_verified_reports", "allow_provisional_reports", "include_verified_score", "include_weak_areas"]) {
    next.sharing[key] = next.sharing[key] === true;
  }
  return next;
}

export function publicAylaMarketingSettings(value = {}) {
  const settings = normalizeAylaMarketingSettings(value);
  return {
    version: settings.version,
    revision: settings.revision,
    program: { ...settings.program },
    sharing: {
      allow_verified_reports: settings.sharing.allow_verified_reports,
      allow_provisional_reports: settings.sharing.allow_provisional_reports,
      include_verified_score: settings.sharing.include_verified_score,
      include_weak_areas: settings.sharing.include_weak_areas,
      card_title: settings.sharing.card_title,
      card_subtitle: settings.sharing.card_subtitle,
      challenge_label: settings.sharing.challenge_label,
      cta_label: settings.sharing.cta_label,
      card_theme: { ...settings.sharing.card_theme },
    },
    attribution: {
      allow_demo_signup: settings.attribution.allow_demo_signup,
    },
  };
}

export function renderAylaMarketingTemplate(template = "", values = {}) {
  return cleanText(template, 2000).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => (
    values[key] === null || values[key] === undefined ? "" : String(values[key])
  )).replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function publicWeakAreas(report = {}, settings = {}) {
  if (settings.sharing?.include_weak_areas !== true) return [];
  const rows = Array.isArray(report.weakAreas) ? report.weakAreas : [];
  return rows
    .map((row) => cleanText(row?.system || row?.systemName || "", 100))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 3);
}

export function buildAylaPublicReadinessSnapshot(report = {}, settingsInput = {}) {
  const settings = normalizeAylaMarketingSettings(settingsInput);
  const evidenceKind = EVIDENCE_KINDS.has(String(report?.evidence?.kind || ""))
    ? String(report.evidence.kind)
    : "provisional_self_report";
  const verified = evidenceKind === "server_verified_diagnostic";
  const allowed = verified
    ? settings.sharing.allow_verified_reports
    : settings.sharing.allow_provisional_reports;
  if (!settings.program.enabled || !settings.program.sharing_enabled || !allowed) {
    throw marketingError("Readiness sharing is not enabled for this report", "READINESS_SHARING_DISABLED", 403);
  }

  const weakAreas = publicWeakAreas(report, settings);
  const primaryFocus = cleanText(
    report?.tutorBriefing?.primaryFocus || weakAreas[0] || "Baseline discovery",
    160,
  );
  const score = verified && settings.sharing.include_verified_score === true
    && Number.isFinite(Number(report?.readiness?.score))
    ? Math.max(0, Math.min(100, Math.round(Number(report.readiness.score))))
    : null;

  return {
    version: 1,
    exam: {
      id: cleanText(report?.exam?.id, 100) || null,
      label: cleanText(report?.exam?.label || "Medical exam", 140),
    },
    evidence: {
      kind: evidenceKind,
      label: cleanText(report?.evidence?.label || (verified ? "Verified diagnostic" : "Provisional starting point"), 160),
      verified,
      provisional: !verified,
    },
    readiness: {
      score,
      level: cleanText(report?.readiness?.level || "Baseline Needed", 120),
      phase: cleanText(report?.readiness?.phase || "Baseline planning", 160),
      pass_prediction: false,
      pass_probability: null,
    },
    focus: primaryFocus,
    weak_areas: weakAreas,
    next_step: cleanText(
      report?.nextAction?.description
        || report?.tutorBriefing?.reason
        || "Use verified work to refine the next study action.",
      360,
    ),
    challenge_label: settings.sharing.challenge_label,
    cta_label: settings.sharing.cta_label,
    privacy: {
      anonymous: true,
      student_name_included: false,
      email_included: false,
      internal_ids_included: false,
      raw_answers_included: false,
    },
  };
}

export function aylaReadinessShareTemplateValues(snapshot = {}, shareUrl = "") {
  const score = snapshot.readiness?.score;
  return {
    exam: snapshot.exam?.label || "medical exam",
    evidence: snapshot.evidence?.label || "Starting readiness",
    readiness: score === null || score === undefined
      ? snapshot.readiness?.level || "Baseline planning"
      : `${score}% verified baseline`,
    phase: snapshot.readiness?.phase || "Baseline planning",
    focus: snapshot.focus || "Baseline discovery",
    weak_areas: (snapshot.weak_areas || []).join(", ") || "Still being verified",
    cta: snapshot.cta_label || "Check your own readiness",
    challenge: snapshot.challenge_label || "Challenge your study partner",
    share_url: shareUrl,
  };
}

export function buildAylaReadinessShareCopy(snapshot = {}, settingsInput = {}, shareUrl = "") {
  const settings = normalizeAylaMarketingSettings(settingsInput);
  const values = aylaReadinessShareTemplateValues(snapshot, shareUrl);
  return {
    title: renderAylaMarketingTemplate(settings.sharing.card_title, values),
    message: renderAylaMarketingTemplate(settings.sharing.share_message, values),
    whatsapp_message: settings.program.whatsapp_enabled
      ? renderAylaMarketingTemplate(settings.sharing.whatsapp_message, values)
      : "",
    cta_label: settings.sharing.cta_label,
    challenge_label: settings.sharing.challenge_label,
  };
}

function escapeXml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapText(value = "", maxCharacters = 42, maxLines = 3) {
  const words = cleanText(value, 500).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[. ]+$/, "")}…`;
  }
  return lines;
}

function svgTextLines(lines, { x, y, size, color, weight = 600, lineHeight = 1.25 } = {}) {
  return `<text x="${x}" y="${y}" font-family="Inter,Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${
    lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : Math.round(size * lineHeight)}">${escapeXml(line)}</tspan>`).join("")
  }</text>`;
}

export function renderAylaReadinessCardSvg(snapshot = {}, settingsInput = {}) {
  const settings = normalizeAylaMarketingSettings(settingsInput);
  const theme = settings.sharing.card_theme;
  const values = aylaReadinessShareTemplateValues(snapshot);
  const title = renderAylaMarketingTemplate(settings.sharing.card_title, values);
  const readiness = values.readiness;
  const weakAreas = snapshot.weak_areas?.length ? snapshot.weak_areas.join(" · ") : "No weak area published";
  const focusLines = wrapText(snapshot.next_step || snapshot.focus, 46, 3);
  const subtitleLines = wrapText(settings.sharing.card_subtitle, 55, 2);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" role="img" aria-label="${escapeXml(title)}">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${theme.background}"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient><filter id="shadow"><feDropShadow dx="0" dy="20" stdDeviation="26" flood-color="${theme.primary}" flood-opacity=".12"/></filter></defs>`,
    `<rect width="1080" height="1080" rx="72" fill="url(#bg)"/>`,
    `<circle cx="944" cy="120" r="220" fill="${theme.accent}" opacity=".08"/>`,
    `<circle cx="84" cy="1000" r="260" fill="${theme.primary}" opacity=".05"/>`,
    `<rect x="72" y="72" width="936" height="936" rx="54" fill="#FFFFFF" fill-opacity=".78" stroke="${theme.primary}" stroke-opacity=".10" filter="url(#shadow)"/>`,
    `<text x="120" y="142" font-family="Inter,Arial,sans-serif" font-size="25" font-weight="800" letter-spacing="5" fill="${theme.accent}">AYLAMED</text>`,
    svgTextLines(wrapText(title, 30, 2), { x: 120, y: 228, size: 54, color: theme.primary, weight: 850, lineHeight: 1.12 }),
    svgTextLines(subtitleLines, { x: 120, y: 350, size: 24, color: theme.muted, weight: 500, lineHeight: 1.35 }),
    `<rect x="120" y="438" width="840" height="176" rx="34" fill="${theme.primary}"/>`,
    `<text x="162" y="494" font-family="Inter,Arial,sans-serif" font-size="21" font-weight="700" letter-spacing="2" fill="#FFFFFF" opacity=".72">READINESS</text>`,
    `<text x="162" y="568" font-family="Inter,Arial,sans-serif" font-size="54" font-weight="850" fill="#FFFFFF">${escapeXml(readiness)}</text>`,
    `<text x="720" y="494" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="700" fill="#FFFFFF" opacity=".72">EVIDENCE</text>`,
    `<text x="720" y="538" font-family="Inter,Arial,sans-serif" font-size="25" font-weight="750" fill="#FFFFFF">${escapeXml(snapshot.evidence?.verified ? "VERIFIED" : "PROVISIONAL")}</text>`,
    `<text x="120" y="688" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="800" letter-spacing="2" fill="${theme.accent}">NEXT FOCUS</text>`,
    svgTextLines(focusLines, { x: 120, y: 738, size: 31, color: theme.primary, weight: 720, lineHeight: 1.35 }),
    `<text x="120" y="882" font-family="Inter,Arial,sans-serif" font-size="19" font-weight="800" letter-spacing="1.5" fill="${theme.muted}">PUBLISHED WEAK AREAS</text>`,
    svgTextLines(wrapText(weakAreas, 60, 2), { x: 120, y: 922, size: 23, color: theme.primary, weight: 620, lineHeight: 1.3 }),
    `<text x="120" y="982" font-family="Inter,Arial,sans-serif" font-size="18" font-weight="650" fill="${theme.muted}">Anonymous snapshot · Not a pass prediction · No raw answers</text>`,
    `</svg>`,
  ].join("");
}

export function normalizeAylaReferralCode(value = "") {
  return cleanText(value, 64).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

export function normalizeAylaCampaign(input = {}, existing = {}) {
  const statusInput = String(input.status ?? existing.status ?? "draft").toLowerCase();
  if (!CAMPAIGN_STATUSES.has(statusInput)) {
    throw marketingError("Campaign status must be draft, active, paused, or archived", "INVALID_CAMPAIGN_STATUS");
  }
  const startsAt = cleanText(input.starts_at ?? input.startsAt ?? existing.starts_at, 40) || null;
  const endsAt = cleanText(input.ends_at ?? input.endsAt ?? existing.ends_at, 40) || null;
  if (startsAt && Number.isNaN(new Date(startsAt).getTime())) {
    throw marketingError("Campaign start date is invalid", "INVALID_CAMPAIGN_START");
  }
  if (endsAt && Number.isNaN(new Date(endsAt).getTime())) {
    throw marketingError("Campaign end date is invalid", "INVALID_CAMPAIGN_END");
  }
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw marketingError("Campaign end date must be after its start date", "INVALID_CAMPAIGN_WINDOW");
  }
  const channels = cleanList(input.channels ?? existing.channels ?? ["whatsapp"], 10)
    .map((item) => item.toLowerCase());
  const unsupportedChannels = channels.filter((channel) => !MARKETING_CHANNELS.has(channel));
  if (unsupportedChannels.length) {
    throw marketingError(
      `Unsupported marketing channel(s): ${unsupportedChannels.join(", ")}`,
      "INVALID_MARKETING_CHANNEL",
    );
  }
  return {
    ...existing,
    name: cleanText(input.name ?? existing.name, 180),
    status: statusInput,
    channels,
    exam_track_ids: cleanList(input.exam_track_ids ?? input.examTrackIds ?? existing.exam_track_ids, 20),
    eligible_plan_ids: cleanList(input.eligible_plan_ids ?? input.eligiblePlanIds ?? existing.eligible_plan_ids, 100),
    starts_at: startsAt,
    ends_at: endsAt,
    cta_label: cleanText(input.cta_label ?? input.ctaLabel ?? existing.cta_label, 180),
    whatsapp_message: cleanText(input.whatsapp_message ?? input.whatsappMessage ?? existing.whatsapp_message, 1600),
    notes: cleanText(input.notes ?? existing.notes, 1000),
  };
}

export function aylaCampaignIsActive(campaign = {}, now = new Date()) {
  if (String(campaign.status || "").toLowerCase() !== "active") return false;
  const timestamp = new Date(now).getTime();
  const starts = campaign.starts_at ? new Date(campaign.starts_at).getTime() : null;
  const ends = campaign.ends_at ? new Date(campaign.ends_at).getTime() : null;
  if (starts && timestamp < starts) return false;
  if (ends && timestamp >= ends) return false;
  return true;
}

export function aylaAttributionWindowOpen(attribution = {}, settingsInput = {}, now = new Date()) {
  const settings = normalizeAylaMarketingSettings(settingsInput);
  const started = new Date(attribution.attributed_at || attribution.signup_at || attribution.createdAt || 0).getTime();
  if (!Number.isFinite(started) || started <= 0) return false;
  return new Date(now).getTime() <= started + settings.attribution.window_days * 86_400_000;
}

export function aylaReferralSelfCheck({
  referrerUserId = "",
  referredUserId = "",
  referrerEmail = "",
  referredEmail = "",
} = {}) {
  if (referrerUserId && referredUserId && String(referrerUserId) === String(referredUserId)) return true;
  const left = cleanText(referrerEmail, 320).toLowerCase();
  const right = cleanText(referredEmail, 320).toLowerCase();
  return Boolean(left && right && left === right);
}

export function aylaRewardDefinitionsForMilestone(settingsInput = {}, milestoneType = "") {
  const settings = normalizeAylaMarketingSettings(settingsInput);
  const type = String(milestoneType || "").toLowerCase();
  const rule = type === "paid_conversion"
    ? settings.rewards.paid
    : type === "verified_diagnostic_completed"
      ? settings.rewards.diagnostic
      : null;
  if (!rule?.enabled) return [];
  return ["referrer", "referred"].map((beneficiaryRole) => ({
    milestone_type: type,
    beneficiary_role: beneficiaryRole,
    label: rule[beneficiaryRole].label,
    value: rule[beneficiaryRole].value,
    unit: rule[beneficiaryRole].unit,
    hold_days: rule.hold_days,
    fulfillment_mode: "manual",
  }));
}

export function aylaRewardReadyAt(milestoneAt = new Date(), holdDays = 0) {
  const date = new Date(milestoneAt);
  if (Number.isNaN(date.getTime())) throw marketingError("Reward milestone date is invalid", "INVALID_REWARD_DATE");
  date.setUTCDate(date.getUTCDate() + Math.max(0, Number(holdDays || 0)));
  return date.toISOString();
}

export function aylaRewardReleaseEligible(reward = {}, {
  now = new Date(),
  blockedAttributionIds = [],
  invalidPaymentIds = [],
} = {}) {
  if (!REWARD_STATUSES.has(String(reward.status || ""))) return false;
  if (String(reward.status) !== "pending_hold") return false;
  if (blockedAttributionIds.map(String).includes(String(reward.attribution_id || ""))) return false;
  if (reward.payment_id && invalidPaymentIds.map(String).includes(String(reward.payment_id))) return false;
  const readyAt = new Date(reward.ready_at || reward.createdAt || 0).getTime();
  return Number.isFinite(readyAt) && readyAt <= new Date(now).getTime();
}

export function aylaMarketingMetrics({
  campaigns = [],
  shares = [],
  events = [],
  attributions = [],
  milestones = [],
  rewards = [],
  payments = [],
} = {}) {
  const paymentById = new Map(payments.map((row) => [String(row.id), row]));
  const validPaidPaymentStatuses = new Set(["completed", "paid", "succeeded"]);
  const paidMilestones = milestones.filter((row) => {
    if (String(row.type) !== "paid_conversion" || String(row.status || "") === "reversed") return false;
    const payment = paymentById.get(String(row.payment_id || ""));
    if (!payment) return true;
    if (String(payment.referral_reward_review_status || "").toLowerCase() === "refund_pending") {
      return false;
    }
    return validPaidPaymentStatuses.has(
      String(payment.status || payment.payment_status || "").toLowerCase(),
    );
  });
  const attributedRevenueCents = paidMilestones.reduce((sum, row) => {
    const payment = paymentById.get(String(row.payment_id || ""));
    return sum + Math.max(0, Number(payment?.final_amount_cents ?? payment?.amount_cents ?? row.amount_cents ?? 0) || 0);
  }, 0);
  return {
    active_campaigns: campaigns.filter((row) => aylaCampaignIsActive(row)).length,
    active_share_links: shares.filter((row) => String(row.status || "active") === "active" && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now())).length,
    share_views: events.filter((row) => String(row.type) === "share_view").length,
    whatsapp_shares: events.filter((row) => String(row.type) === "whatsapp_share").length,
    referred_signups: attributions.filter((row) => !["blocked", "cancelled"].includes(String(row.status))).length,
    verified_diagnostics: milestones.filter((row) => String(row.type) === "verified_diagnostic_completed").length,
    paid_conversions: paidMilestones.length,
    attributed_revenue_cents: attributedRevenueCents,
    rewards_pending_hold: rewards.filter((row) => String(row.status) === "pending_hold").length,
    rewards_ready: rewards.filter((row) => String(row.status) === "ready_for_fulfillment").length,
    rewards_fulfilled: rewards.filter((row) => String(row.status) === "fulfilled").length,
    rewards_refund_review: rewards.filter((row) => row.refund_after_fulfillment === true).length,
  };
}

export function normalizeAylaAttributionStatus(value = "attributed") {
  const status = String(value || "").toLowerCase();
  if (!ATTRIBUTION_STATUSES.has(status)) {
    throw marketingError("Referral status is invalid", "INVALID_REFERRAL_STATUS");
  }
  return status;
}

export function normalizeAylaRewardStatus(value = "pending_hold") {
  const status = String(value || "").toLowerCase();
  if (!REWARD_STATUSES.has(status)) {
    throw marketingError("Reward status is invalid", "INVALID_REWARD_STATUS");
  }
  return status;
}
