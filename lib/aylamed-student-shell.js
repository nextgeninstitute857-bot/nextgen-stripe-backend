import { normalizeExamTrack } from "./content-import-adapter.js";
import {
  aylaNclexVariantLabel,
  aylaStudentNclexVariant,
} from "./aylamed-nclex-variant.js";

const EXAM_TRACKS = Object.freeze({
  "usmle-step-1": { id: "usmle_step_1", registryId: "usmle-step-1", label: "USMLE Step 1" },
  "usmle-step-2": { id: "usmle_step_2_ck", registryId: "usmle-step-2", label: "USMLE Step 2 CK" },
  "usmle-step-3": { id: "usmle_step_3", registryId: "usmle-step-3", label: "USMLE Step 3" },
  plab: { id: "plab", registryId: "plab", label: "PLAB" },
  amc: { id: "amc", registryId: "amc", label: "AMC" },
  mccqe: { id: "mccqe", registryId: "mccqe", label: "MCCQE" },
  nclex: { id: "nclex", registryId: "nclex", label: "NCLEX" },
});

export const AYLA_STUDENT_FEATURES = Object.freeze([
  { key: "roadmap", label: "My Roadmap", route: "roadmap", aliases: ["roadmap"] },
  { key: "personal_tutor", label: "Personal Tutor", route: "personal-tutor", aliases: ["personal_tutor", "tutor", "ai_coach"] },
  { key: "assessments", label: "Assessments", route: "assessments", aliases: ["assessments", "assessment"] },
  { key: "nbme_center", label: "NBME Center", route: "nbme", aliases: ["nbme_center", "nbme", "self_assessments", "readiness_checks"] },
  { key: "library", label: "Library", route: "library", aliases: ["library", "books", "knowledge_search"] },
  { key: "qbank", label: "QBank", route: "qbank", aliases: ["qbank", "question_bank"] },
  { key: "content_hub", label: "Content Hub", route: "content-hub", aliases: ["content_hub", "video_library", "videos", "knowledge_search"] },
  { key: "dynamic_notebook", label: "Dynamic Notebook", route: "notebook", aliases: ["dynamic_notebook", "notebook", "notebooks", "knowledge_search"] },
  { key: "revision", label: "Revision", route: "revision", aliases: ["revision", "incorrect_review", "weak_areas"] },
  { key: "flashcards", label: "Flashcards", route: "flashcards", aliases: ["flashcards", "flashcard"] },
  { key: "study_partner", label: "Study Partner", route: "study-partner", aliases: ["study_partner", "study_partners"] },
  { key: "leaderboard", label: "Leaderboard", route: "leaderboard", aliases: ["leaderboard", "community_leaderboard"] },
  { key: "progress", label: "Progress", route: "progress", aliases: ["progress", "analytics", "roadmap"] },
]);

function cleanString(value = "", max = 180) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanList(value) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(rows.map((item) => cleanString(item, 120)).filter(Boolean))];
}

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

function normalizeFeature(value = "") {
  return cleanString(value, 120).toLowerCase().replace(/[\s-]+/g, "_");
}

function canonicalFeature(value = "") {
  const normalized = normalizeFeature(value);
  const direct = AYLA_STUDENT_FEATURES.find((feature) => feature.key === normalized);
  if (direct) return direct.key;
  return AYLA_STUDENT_FEATURES.find((feature) => feature.aliases.includes(normalized))?.key || normalized;
}

export function normalizeAylaShellExamTrack(value = "") {
  const registryId = normalizeExamTrack(value);
  return EXAM_TRACKS[registryId]?.id || null;
}

export function normalizeAylaRegistryExamTrack(value = "") {
  const id = normalizeAylaShellExamTrack(value);
  return Object.values(EXAM_TRACKS).find((row) => row.id === id)?.registryId || null;
}

export function aylaShellExamDefinition(value = "") {
  const id = normalizeAylaShellExamTrack(value);
  const row = Object.values(EXAM_TRACKS).find((item) => item.id === id);
  return row ? { ...row } : null;
}

export function aylaScopedEnrollmentKey(userId, planId, type = "paid", examTrack = null) {
  const base = `ayla:${userId}:${planId || "manual"}:${type}`;
  if (examTrack === null || examTrack === undefined || String(examTrack).trim() === "") return base;
  const examTrackId = normalizeAylaShellExamTrack(examTrack);
  if (!examTrackId) throw new Error("A supported AylaMed exam track is required for scoped access");
  return `${base}:${examTrackId}`;
}

export function aylaShellEnrollmentActive(enrollment = {}, now = Date.now()) {
  if (!enrollment || enrollment.access_granted === false) return false;
  const status = cleanString(enrollment.status || "active", 40).toLowerCase();
  if (["revoked", "disabled", "deleted", "expired", "pending", "cancelled", "canceled"].includes(status) || enrollment.revoked_at || enrollment.revokedAt) return false;
  const startsAt = enrollment.access_starts_at || enrollment.accessStartsAt || enrollment.starts_at || enrollment.startsAt;
  const expiresAt = enrollment.access_expires_at || enrollment.accessExpiresAt || enrollment.expires_at || enrollment.expiresAt;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (startsAt) {
    const startsMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsMs) && startsMs > safeNow) return false;
  }
  if (!expiresAt) return true;
  const expiresMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresMs) && expiresMs >= safeNow;
}

function planForEnrollment(enrollment = {}, plansById = {}) {
  const planId = enrollment.plan_id || enrollment.planId;
  if (!planId) return null;
  if (plansById instanceof Map) return plansById.get(String(planId)) || null;
  return plansById?.[String(planId)] || null;
}

function enrollmentStudentId(enrollment = {}) {
  return cleanString(enrollment.student_id || enrollment.studentId || enrollment.ayla_student_id || enrollment.aylaStudentId || "", 160) || null;
}

function enrollmentIsDemo(enrollment = {}, plan = {}) {
  const type = cleanString(enrollment.type || plan?.plan_type || plan?.type || "", 40).toLowerCase();
  return enrollment.is_demo === true || plan?.is_demo === true || type === "demo" || type === "trial";
}

function enrollmentExamTracks(enrollment = {}, plan = {}) {
  const tracks = [
    enrollment.exam_track_id,
    enrollment.examTrackId,
    enrollment.exam_track,
    enrollment.examTrack,
    enrollment.exam,
    ...cleanList(enrollment.exam_tracks || enrollment.examTracks),
    plan?.exam_track_id,
    plan?.examTrackId,
    plan?.exam_track,
    plan?.examTrack,
    plan?.exam,
    ...cleanList(plan?.exam_tracks || plan?.examTracks),
  ];
  return [...new Set(tracks.map(normalizeAylaShellExamTrack).filter(Boolean))];
}

function featureAccess(enrollment = {}, plan = {}) {
  // A stored plan is the live feature authority. Enrollment feature snapshots
  // remain a fallback only for legacy/manual grants with no resolvable plan;
  // otherwise an old snapshot could defeat a later admin disable.
  const planIsAuthoritative = Boolean(plan && typeof plan === "object" && (plan.id || plan.included_features || plan.features || plan.is_full_access !== undefined));
  const fullAccess = planIsAuthoritative ? plan?.is_full_access === true : enrollment.is_full_access === true;
  const configured = new Set((planIsAuthoritative
    ? [...cleanList(plan?.included_features), ...cleanList(plan?.features)]
    : [...cleanList(enrollment.included_features), ...cleanList(enrollment.features)]
  ).map(canonicalFeature).filter(Boolean));
  const enabled = AYLA_STUDENT_FEATURES.filter((feature) => fullAccess || configured.has(feature.key)).map((feature) => feature.key);
  return { fullAccess, configured: [...configured].sort(), enabled };
}

function entitlementTimestamp(row = {}) {
  const enrollment = row.enrollment || {};
  const valuesToTry = [
    enrollment.access_starts_at,
    enrollment.accessStartsAt,
    enrollment.updatedAt,
    enrollment.updated_at,
    enrollment.createdAt,
    enrollment.created_at,
  ];
  for (const value of valuesToTry) {
    const parsed = new Date(value || "").getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function entitlementExpiry(row = {}) {
  const enrollment = row.enrollment || {};
  const value = enrollment.access_expires_at || enrollment.accessExpiresAt || enrollment.expires_at || enrollment.expiresAt;
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareEntitlements(left, right) {
  const recency = entitlementTimestamp(right) - entitlementTimestamp(left);
  if (recency) return recency;
  const expiry = entitlementExpiry(right) - entitlementExpiry(left);
  if (expiry) return expiry;
  return String(left.enrollment.id || "").localeCompare(String(right.enrollment.id || ""));
}

function enrollmentMatchesLegacyProfile({ enrollment, examTrackId, legacyExamTrackId, legacyStudentId, defaultStudentId }) {
  if (!legacyExamTrackId || legacyExamTrackId !== examTrackId) return false;
  const scopedStudentId = enrollmentStudentId(enrollment);
  if (scopedStudentId) return Boolean(legacyStudentId && scopedStudentId === String(legacyStudentId));
  if (defaultStudentId) return Boolean(legacyStudentId && String(legacyStudentId) === String(defaultStudentId));
  return Boolean(legacyStudentId);
}

export function resolveAylaExamFeatureEntitlement({
  enrollments = [],
  plansById = {},
  userId,
  requestedExamTrack,
  feature = null,
  legacyExamTrack = null,
  legacyStudentId = null,
  defaultStudentId = null,
  enforceStudentScope = false,
  now = Date.now(),
} = {}) {
  const examTrackId = normalizeAylaShellExamTrack(requestedExamTrack);
  const registryExamTrack = normalizeAylaRegistryExamTrack(requestedExamTrack);
  const profileExamTrackId = normalizeAylaShellExamTrack(legacyExamTrack);
  if (!examTrackId) {
    return { allowed: false, reason: "invalid_exam_track", exam_track_id: null, exam_track: null };
  }

  const matched = values(enrollments)
    .filter((enrollment) => String(enrollment.user_id || enrollment.ayla_user_id || enrollment.userId || enrollment.aylaUserId || "") === String(userId || ""))
    .filter((enrollment) => aylaShellEnrollmentActive(enrollment, now))
    .map((enrollment) => {
      const plan = planForEnrollment(enrollment, plansById);
      const scopedTracks = enrollmentExamTracks(enrollment, plan);
      const trackMatches = scopedTracks.length
        ? scopedTracks.includes(examTrackId)
        : enrollmentMatchesLegacyProfile({
            enrollment,
            examTrackId,
            legacyExamTrackId: profileExamTrackId,
            legacyStudentId,
            defaultStudentId,
          });
      const scopedStudentId = enrollmentStudentId(enrollment);
      const studentMatches = !enforceStudentScope || !scopedStudentId || Boolean(legacyStudentId && String(scopedStudentId) === String(legacyStudentId));
      return {
        enrollment,
        plan,
        scopedTracks,
        explicitlyScoped: scopedTracks.length > 0,
        demo: enrollmentIsDemo(enrollment, plan),
        featureAccess: featureAccess(enrollment, plan),
        matches: trackMatches && studentMatches,
      };
    })
    .filter((row) => row.matches);

  if (!matched.length) {
    return {
      allowed: false,
      reason: "no_active_exam_entitlement",
      exam_track_id: examTrackId,
      exam_track: registryExamTrack,
    };
  }

  const paid = matched.filter((row) => !row.demo);
  const tier = (paid.length ? paid : matched.filter((row) => row.demo)).sort(compareEntitlements);
  const selected = tier[0];
  const normalizedFeature = feature ? normalizeFeature(feature) : null;
  const featureDefinition = normalizedFeature
    ? AYLA_STUDENT_FEATURES.find((row) => row.key === normalizedFeature || row.aliases.includes(normalizedFeature))
    : null;
  const featureKey = featureDefinition?.key || normalizedFeature;
  const featureIncluded = !featureKey
    || selected.featureAccess.fullAccess
    || selected.featureAccess.enabled.includes(featureKey)
    || selected.featureAccess.configured.includes(featureKey);

  if (!featureIncluded) {
    return {
      allowed: false,
      reason: "feature_not_included",
      exam_track_id: examTrackId,
      exam_track: registryExamTrack,
      entitlement_type: selected.demo ? "demo" : "paid",
      enrollment_id: selected.enrollment.id || null,
      plan_id: selected.plan?.id || selected.enrollment.plan_id || null,
      enabled_features: selected.featureAccess.enabled,
      explicitly_scoped: selected.explicitlyScoped,
    };
  }

  return {
    allowed: true,
    reason: "active_entitlement",
    exam_track_id: examTrackId,
    exam_track: registryExamTrack,
    entitlement_type: selected.demo ? "demo" : "paid",
    enrollment_id: selected.enrollment.id || null,
    plan_id: selected.plan?.id || selected.enrollment.plan_id || null,
    plan_name: selected.plan?.name || selected.enrollment.plan_name || null,
    expires_at: selected.enrollment.access_expires_at || selected.enrollment.accessExpiresAt || null,
    starts_at: selected.enrollment.access_starts_at || selected.enrollment.accessStartsAt || null,
    enabled_features: selected.featureAccess.enabled,
    configured_features: selected.featureAccess.configured,
    full_access: selected.featureAccess.fullAccess,
    explicitly_scoped: selected.explicitlyScoped,
    scoped_student_id: enrollmentStudentId(selected.enrollment),
  };
}

function studentExamTrack(student = {}) {
  return normalizeAylaShellExamTrack(student.examTrackId || student.exam_track_id || student.examTrack || student.exam_track || student.exam);
}

function studentOwnerId(student = {}) {
  return cleanString(student.ayla_user_id || student.aylaUserId || student.user_id || student.userId || "", 160);
}

function studentTimestamp(student = {}) {
  const parsed = new Date(student.updatedAt || student.updated_at || student.createdAt || student.created_at || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dashboardNavigation(examTrackId, enabledFeatures = []) {
  const enabled = new Set(enabledFeatures);
  return AYLA_STUDENT_FEATURES.map((feature) => ({
    key: feature.key,
    label: feature.label,
    route: feature.route,
    path: `/app/exams/${examTrackId}/${feature.route}`,
    enabled: enabled.has(feature.key),
    reason: enabled.has(feature.key) ? null : "feature_not_included",
  }));
}

function candidateExamTracks({ enrollments, plansById, profiles, activeStudentId, now }) {
  const tracks = new Set();
  const profileById = new Map(profiles.map((student) => [String(student.id), student]));
  const activeProfile = activeStudentId ? profileById.get(String(activeStudentId)) : null;
  const singleProfile = profiles.length === 1 ? profiles[0] : null;

  for (const enrollment of values(enrollments).filter((row) => aylaShellEnrollmentActive(row, now))) {
    const plan = planForEnrollment(enrollment, plansById);
    const explicit = enrollmentExamTracks(enrollment, plan);
    explicit.forEach((track) => tracks.add(track));
    if (explicit.length) continue;
    const scopedProfile = enrollmentStudentId(enrollment) ? profileById.get(String(enrollmentStudentId(enrollment))) : null;
    const legacyProfile = scopedProfile || activeProfile || singleProfile;
    const legacyTrack = studentExamTrack(legacyProfile || {});
    if (legacyTrack) tracks.add(legacyTrack);
  }
  return [...tracks];
}

function profileForDashboard(profiles, examTrackId, access, activeStudentId) {
  const matching = profiles.filter((student) => studentExamTrack(student) === examTrackId).sort((a, b) => studentTimestamp(b) - studentTimestamp(a));
  if (access.scoped_student_id) {
    const scoped = matching.find((student) => String(student.id) === String(access.scoped_student_id));
    if (scoped) return scoped;
  }
  const active = matching.find((student) => String(student.id) === String(activeStudentId || ""));
  return active || matching[0] || null;
}

export function selectAylaReadyDashboardFallback(shell = {}, {
  forcedExamTrackId = null,
  selectedProfileAvailable = false,
  allowedExamTrackIds = [],
} = {}) {
  if (forcedExamTrackId || selectedProfileAvailable) return null;
  const active = shell.active_dashboard || null;
  if (active?.profile_status === "ready" && active?.student_id) return null;
  const allowed = new Set(values(allowedExamTrackIds).map(normalizeAylaShellExamTrack).filter(Boolean));
  return values(shell.dashboards).find((dashboard) => (
    dashboard?.profile_status === "ready"
    && dashboard?.student_id
    && (!allowed.size || allowed.has(normalizeAylaShellExamTrack(dashboard.exam_track_id)))
  )) || null;
}

export function resolveAylaStudentShell({
  userId,
  students = [],
  enrollments = [],
  plansById = {},
  activeStudentId = null,
  requestedStudentId = null,
  requestedExamTrack = null,
  now = Date.now(),
} = {}) {
  const hasRequestedExamTrack = requestedExamTrack !== null && requestedExamTrack !== undefined && String(requestedExamTrack).trim() !== "";
  const ownedProfiles = values(students)
    .filter((student) => String(studentOwnerId(student)) === String(userId || ""))
    .filter((student) => studentExamTrack(student));
  const ownedById = new Map(ownedProfiles.map((student) => [String(student.id), student]));
  const candidateTracks = candidateExamTracks({ enrollments: values(enrollments).filter((row) => String(row.user_id || row.ayla_user_id || row.userId || row.aylaUserId || "") === String(userId || "")), plansById, profiles: ownedProfiles, activeStudentId, now });

  const dashboards = [];
  for (const examTrackId of candidateTracks) {
    const profileCandidates = ownedProfiles.filter((student) => studentExamTrack(student) === examTrackId).sort((a, b) => studentTimestamp(b) - studentTimestamp(a));
    const legacyProfile = profileCandidates.find((student) => String(student.id) === String(activeStudentId || "")) || profileCandidates[0] || null;
    const access = resolveAylaExamFeatureEntitlement({
      enrollments,
      plansById,
      userId,
      requestedExamTrack: examTrackId,
      legacyExamTrack: studentExamTrack(legacyProfile || {}),
      legacyStudentId: legacyProfile?.id || null,
      defaultStudentId: activeStudentId,
      now,
    });
    if (!access.allowed) continue;
    const profile = profileForDashboard(ownedProfiles, examTrackId, access, activeStudentId);
    const definition = aylaShellExamDefinition(examTrackId);
    const accessEnrollment = values(enrollments).find((enrollment) => String(enrollment.id || "") === String(access.enrollment_id || "")) || null;
    const examVariant = examTrackId === "nclex"
      ? aylaStudentNclexVariant(profile || {}) || aylaStudentNclexVariant(accessEnrollment || {})
      : "";
    dashboards.push({
      id: examTrackId,
      exam_track_id: examTrackId,
      exam_track: definition.registryId,
      label: examVariant ? aylaNclexVariantLabel(examVariant) : definition.label,
      exam_variant: examVariant || null,
      student_id: profile?.id || null,
      profile_status: profile ? "ready" : "setup_required",
      entitlement: {
        type: access.entitlement_type,
        enrollment_id: access.enrollment_id,
        plan_id: access.plan_id,
        plan_name: access.plan_name,
        starts_at: access.starts_at,
        expires_at: access.expires_at,
        explicitly_scoped: access.explicitly_scoped,
      },
      features: Object.fromEntries(AYLA_STUDENT_FEATURES.map((feature) => [feature.key, access.enabled_features.includes(feature.key)])),
      navigation: dashboardNavigation(examTrackId, access.enabled_features),
      switch_payload: { exam_track_id: examTrackId, student_id: profile?.id || null },
    });
  }

  dashboards.sort((left, right) => {
    if (left.entitlement.type !== right.entitlement.type) return left.entitlement.type === "paid" ? -1 : 1;
    return left.label.localeCompare(right.label);
  });

  let deniedReason = null;
  const requestedTrackId = hasRequestedExamTrack ? normalizeAylaShellExamTrack(requestedExamTrack) : null;
  const requestedProfile = requestedStudentId ? ownedById.get(String(requestedStudentId)) || null : null;
  if (hasRequestedExamTrack && !requestedTrackId) deniedReason = "invalid_exam_track";
  if (requestedStudentId && !requestedProfile) deniedReason = "student_not_owned";
  if (!deniedReason && requestedProfile && requestedTrackId && studentExamTrack(requestedProfile) !== requestedTrackId) deniedReason = "student_exam_mismatch";

  let activeDashboard = null;
  if (!deniedReason && requestedTrackId) activeDashboard = dashboards.find((row) => row.exam_track_id === requestedTrackId) || null;
  if (!deniedReason && !activeDashboard && requestedProfile) activeDashboard = dashboards.find((row) => row.student_id && String(row.student_id) === String(requestedProfile.id)) || null;
  if (!deniedReason && activeDashboard && requestedProfile && String(activeDashboard.student_id || "") !== String(requestedProfile.id)) {
    activeDashboard = null;
    deniedReason = "no_active_exam_entitlement";
  }
  if (!deniedReason && !activeDashboard && !requestedTrackId && !requestedStudentId && activeStudentId) activeDashboard = dashboards.find((row) => row.student_id && String(row.student_id) === String(activeStudentId)) || null;
  if (!deniedReason && !activeDashboard && !requestedTrackId && !requestedStudentId) activeDashboard = dashboards[0] || null;
  if (!deniedReason && !activeDashboard && (requestedTrackId || requestedStudentId)) deniedReason = "no_active_exam_entitlement";

  return {
    dashboards,
    active_dashboard: activeDashboard,
    active_exam_track_id: activeDashboard?.exam_track_id || null,
    active_student_id: activeDashboard?.student_id || null,
    can_switch: dashboards.length > 1,
    denied_reason: deniedReason,
  };
}
