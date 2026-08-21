import crypto from "node:crypto";

const BLOCKED_RESOURCE_STATES = new Set([
  "archived",
  "blocked",
  "deleted",
  "disabled",
  "inactive",
  "missing_from_folder",
  "rejected",
  "removed",
]);

function clean(value) {
  return String(value || "").trim();
}

export function aylaVimeoProviderId(row = {}) {
  const direct = clean(
    row.vimeoId
      || row.vimeo_id
      || row.providerId
      || row.provider_id
      || row.videoId
      || row.video_id,
  );
  if (/^\d+$/.test(direct)) return direct;
  const urls = [
    row.vimeoEmbedUrl,
    row.vimeo_embed_url,
    row.embedUrl,
    row.embed_url,
    row.vimeoUrl,
    row.vimeo_url,
  ];
  for (const raw of urls) {
    const match = clean(raw).match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i);
    if (match) return match[1];
  }
  return "";
}

export function aylaVimeoPlaybackDomainFingerprint(domains = [], build = "") {
  const normalized = [...new Set(domains
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean))]
    .sort();
  return crypto.createHash("sha256")
    .update(`${clean(build)}\n${normalized.join("\n")}`)
    .digest("hex");
}

export function aylaVimeoPlaybackEligible(row = {}) {
  const type = clean(row.type || row.resourceType || row.resource_type)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (type && !["video", "vimeo", "vimeo_video"].includes(type)) return false;
  if (!aylaVimeoProviderId(row)) return false;
  if (row.approved === false || row.studentVisible === false || row.student_visible === false) return false;
  const status = clean(row.status || "active").toLowerCase().replace(/[\s-]+/g, "_");
  const membership = clean(row.folderMembershipStatus || row.folder_membership_status)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (BLOCKED_RESOURCE_STATES.has(status) || BLOCKED_RESOURCE_STATES.has(membership)) return false;
  return true;
}

function examPriority(row = {}) {
  const exam = clean(
    row.sourceExamTrackId
      || row.source_exam_track_id
      || row.examTrackId
      || row.exam_track_id
      || row.examTrack
      || row.exam_track,
  ).toLowerCase().replace(/[\s-]+/g, "_");
  if (["mccqe", "mccqe1", "usmle_step_2", "usmle_step_2_ck"].includes(exam)) return 0;
  if (exam === "usmle_step_3") return 1;
  if (exam === "usmle_step_1") return 2;
  return 3;
}

export function selectAylaVimeoPlaybackCandidates({
  resources = [],
  fingerprint = "",
  limit = 25,
  now = Date.now(),
} = {}) {
  const byVideoId = new Map();
  for (const row of resources) {
    if (!aylaVimeoPlaybackEligible(row)) continue;
    const videoId = aylaVimeoProviderId(row);
    const currentFingerprint = clean(
      row.vimeoEmbedDomainFingerprint || row.vimeo_embed_domain_fingerprint,
    );
    if (fingerprint && currentFingerprint === fingerprint) continue;
    const nextAttemptAt = Date.parse(clean(
      row.vimeoEmbedReconcileNextAttemptAt || row.vimeo_embed_reconcile_next_attempt_at,
    ));
    const attemptedFingerprint = clean(
      row.vimeoEmbedReconcileFingerprint || row.vimeo_embed_reconcile_fingerprint,
    );
    if (Number.isFinite(nextAttemptAt)
      && nextAttemptAt > Number(now)
      && attemptedFingerprint === fingerprint) continue;
    const priority = examPriority(row);
    const existing = byVideoId.get(videoId);
    if (!existing || priority < existing.priority) {
      byVideoId.set(videoId, { videoId, priority });
    }
  }
  return [...byVideoId.values()]
    .sort((left, right) => left.priority - right.priority
      || Number(left.videoId) - Number(right.videoId)
      || left.videoId.localeCompare(right.videoId))
    .slice(0, Math.max(1, Math.min(100_000, Number(limit) || 25)))
    .map((row) => row.videoId);
}

export function applyAylaVimeoPlaybackConfig(row = {}, config = {}, {
  fingerprint = "",
  domains = [],
  updatedAt = new Date().toISOString(),
} = {}) {
  const embedUrl = clean(config.embed_url || config.embedUrl);
  let privacyHash = clean(row.vimeoPrivacyHash || row.vimeo_privacy_hash);
  if (embedUrl) {
    try {
      privacyHash = new URL(embedUrl).searchParams.get("h") || privacyHash;
    } catch {
      // The provider URL has already been verified upstream; preserve the stored hash on parse failure.
    }
  }
  const confirmedDomains = Array.isArray(config.allowed_domains)
    ? config.allowed_domains
    : domains;
  return {
    ...row,
    ...(embedUrl ? { vimeoEmbedUrl: embedUrl } : {}),
    vimeoPrivacyHash: privacyHash,
    vimeoEmbedDomainFingerprint: fingerprint,
    vimeoEmbedDomains: [...new Set(confirmedDomains.map((value) => clean(value)).filter(Boolean))],
    vimeoEmbedRequestedDomains: [...new Set(domains.map((value) => clean(value)).filter(Boolean))],
    vimeoEmbedDomainsEnsuredAt: updatedAt,
    vimeoEmbedPrivacyMode: clean(config.privacy_embed || config.privacyEmbed || "whitelist") || "whitelist",
    vimeoEmbedFallbackMode: clean(config.fallback_mode || config.fallbackMode) || null,
    updatedAt,
  };
}
