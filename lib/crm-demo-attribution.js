import { randomBytes, randomUUID } from "node:crypto";

export const DEMO_INVITE_PARAM = "ayla_invite";
const DEMO_URL = "https://nextgenusmle.live/demo";
const day = 86400000;
const list = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value ?? "").trim();
const email = (value) => clean(value).toLowerCase();
const phone = (value) => clean(value).replace(/\D/g, "");
const validToken = (value) => /^[A-Za-z0-9_-]{32}$/.test(clean(value));

// This random identifier is attribution only: it never authenticates a user,
// grants access, or exposes a lead's phone/email in a public URL.
export function ensureDemoInvitation(lead, now = new Date().toISOString()) {
  if (!lead?.id) return null;
  const invites = list(lead.demo_invitations);
  const existing = invites.find((row) => validToken(row.token) && Date.parse(row.expires_at) > Date.parse(now));
  if (existing) return existing;
  const invite = {
    id: randomUUID(), token: randomBytes(24).toString("base64url"),
    created_at: now, expires_at: new Date(Date.parse(now) + 30 * day).toISOString(),
    sent_at: null, opened_at: null, activations: [],
    source: {
      meta_ad_id: clean(lead.meta_ad_id) || null,
      meta_ad_name: clean(lead.meta_ad_name) || null,
      meta_campaign_id: clean(lead.meta_campaign_id) || null,
      campaign_name: clean(lead.campaign_name) || null,
      meta_ctwa_clid: clean(lead.meta_ctwa_clid) || null,
      origin: clean(lead.lead_origin || lead.source_channel || lead.source_platform) || null,
    },
  };
  lead.demo_invitations = [...invites, invite];
  return invite;
}

export function demoInvitationUrl(invite) {
  return invite && validToken(invite.token) ? `${DEMO_URL}?${DEMO_INVITE_PARAM}=${invite.token}` : DEMO_URL;
}

export function trackDemoLinks(text, invite) {
  if (!invite || !validToken(invite.token)) return text;
  return String(text || "").replace(/https:\/\/[^\s<>"']+/gi, (match) => {
    const suffix = match.match(/[.,!;:)\]]+$/)?.[0] || "";
    let url;
    try { url = new URL(suffix ? match.slice(0, -suffix.length) : match); } catch { return match; }
    // Only the demo landing pages, never another product or a sub-path.
    if (url.origin !== "https://nextgenusmle.live" || !["/demo", "/try-demo"].includes(url.pathname)) return match;
    url.searchParams.set(DEMO_INVITE_PARAM, invite.token);
    return `${url.href}${suffix}`;
  });
}

export function recordDemoInvitationSent({ lead, invite, text, channel, providerMessageId, sentBy = "team", now = new Date().toISOString() }) {
  if (!lead || !invite || !providerMessageId || !String(text || "").includes(`${DEMO_INVITE_PARAM}=${invite.token}`)) return false;
  invite.sent_at ||= now;
  invite.last_sent_at = now;
  invite.channel = channel;
  invite.sent_by = sentBy;
  invite.provider_message_id = providerMessageId;
  lead.demo_offered_at ||= now;
  lead.demo_tracking = demoTrackingSummary(lead);
  return true;
}

export function findDemoInvitation(db, token, now = new Date().toISOString()) {
  if (!validToken(token)) return null;
  for (const lead of list(db?.leads)) {
    const invite = list(lead.demo_invitations).find((row) => row.token === token && row.sent_at && Date.parse(row.expires_at) > Date.parse(now));
    if (invite) return { lead, invite };
  }
  return null;
}

export function recordDemoInvitationOpened(db, token, now = new Date().toISOString()) {
  const match = findDemoInvitation(db, token, now);
  if (!match) return false;
  // A rendered landing page is not proof of human attention or demo activation.
  // Record once, so refreshes and link-preview bots cannot inflate conversions.
  if (match.invite.opened_at) return false;
  match.invite.opened_at = now;
  match.lead.demo_tracking = demoTrackingSummary(match.lead);
  return true;
}

function contactMatch(lead, user) {
  const knownUserId = clean(lead.lms_student_id || lead.student_id);
  if (knownUserId) return knownUserId === clean(user.id) ? "matched" : "different_account";
  const knownEmail = email(lead.email || lead.student_email);
  const knownPhone = phone(lead.whatsapp || lead.whatsapp_phone || lead.phone || lead.wa_id);
  const userEmail = email(user.email);
  const userPhone = phone(user.phone || user.phone_number);
  if ((knownEmail && knownEmail === userEmail) || (knownPhone && knownPhone === userPhone)) return "matched";
  if ((knownEmail && userEmail) || (knownPhone && userPhone)) return "different_account";
  return "unconfirmed";
}

export function recordDemoActivation({ db, token, user, enrollments = [], hadDemoBefore = false, now = new Date().toISOString() }) {
  const match = findDemoInvitation(db, token, now);
  if (!match || !user?.id || (user.role && !["student", "user"].includes(clean(user.role).toLowerCase()))) return { status: "unattributed" };
  const demos = enrollments.filter((row) => row.is_demo === true && row.access_granted !== false && row.status === "demo_active");
  if (!demos.length) return { status: "no_demo_activation" };
  const { lead, invite } = match;
  const prior = list(lead.demo_invitations).flatMap((row) => list(row.activations)).find((row) => row.student_id === String(user.id));
  if (prior) {
    prior.enrollment_ids = [...new Set([...list(prior.enrollment_ids), ...demos.map((row) => row.id)])];
    lead.demo_tracking = demoTrackingSummary(lead);
    return { status: "already_recorded", activation: prior };
  }
  const activation = {
    id: randomUUID(), student_id: String(user.id), student_email: clean(user.email),
    enrollment_ids: [...new Set(demos.map((row) => row.id))],
    activated_at: now, identity_status: contactMatch(lead, user),
    kind: demos.some((row) => row.created === true) ? (hadDemoBefore ? "renewed_demo" : "new_demo") : "existing_demo",
    evidence_source: "authenticated_lms_demo_activation",
    attribution_method: "ayla_invitation_link",
  };
  invite.activations = [...list(invite.activations), activation];
  // A forwarded link still has link attribution, but must not make us claim
  // that the original WhatsApp contact signed up, paid, or watched a recording.
  if (activation.identity_status === "matched") {
    lead.demo_started_at ||= now;
    lead.demo_activation_evidence = "authenticated_lms_demo_activation";
    lead.lms_student_id ||= String(user.id);
  }
  lead.demo_tracking = demoTrackingSummary(lead);
  return { status: "recorded", activation };
}

export function demoTrackingSummary(lead = {}) {
  const invites = list(lead.demo_invitations);
  const sent = invites.filter((row) => row.sent_at);
  const activations = sent.flatMap((row) => list(row.activations).map((activation) => ({ ...activation, source: row.source, sent_by: row.sent_by })));
  return {
    sent_at: sent[0]?.sent_at || null,
    opened_at: sent.find((row) => row.opened_at)?.opened_at || null,
    activations,
    new_demo_count: activations.filter((row) => row.kind === "new_demo").length,
    source: sent[0]?.source || null,
  };
}

export function demoAttributionForEnrollment(db, enrollmentId) {
  for (const lead of list(db?.leads)) {
    for (const invite of list(lead.demo_invitations)) {
      const activation = list(invite.activations).find((row) => list(row.enrollment_ids).includes(enrollmentId));
      if (activation) return { lead_id: lead.id, lead_name: lead.name || lead.lead_name || "", source: invite.source, ...activation };
    }
  }
  return null;
}
