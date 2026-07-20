import { normalizeAylaShellExamTrack } from "./aylamed-student-shell.js";

export const AYLA_SUCCESS_STORY_CONTENT_TYPE = "aylamed_success_story_strategy";

export const AYLA_SUCCESS_STORY_EVIDENCE_TYPES = Object.freeze([
  "verified_platform_progress",
  "verified_assessment_improvement",
  "admin_reviewed_student_report",
  "mixed_verified_evidence",
]);

const STORY_STATES = new Set(["draft", "needs_review", "approved", "rejected", "revoked", "archived"]);
const REVIEW_ACTIONS = new Set(["submit", "approve", "reject", "revoke", "archive"]);
const FORBIDDEN_INPUT_FIELDS = [
  "student_name",
  "student_email",
  "student_phone",
  "student_whatsapp",
  "student_address",
  "correct_answer",
  "answer_key",
];

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanKey(value = "") {
  return cleanText(value, 120).toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function cleanList(value, maxItems = 20, maxLength = 120) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : [];
  return [...new Set(rows.map((row) => cleanText(row, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function storyError(message, code, details = null, statusCode = 400) {
  return Object.assign(new Error(message), { code, details, statusCode });
}

function normalizeStrategyStep(value = {}, index = 0) {
  const row = typeof value === "string" ? { action: value } : value && typeof value === "object" ? value : {};
  const action = cleanText(row.action || row.strategy || row.title, 500);
  if (!action) return null;
  return {
    id: cleanKey(row.id) || `step_${index + 1}`,
    action,
    why_it_helped: cleanText(row.why_it_helped || row.whyItHelped || row.rationale, 700) || null,
    use_when: cleanText(row.use_when || row.useWhen || row.context, 500) || null,
    caution: cleanText(row.caution || row.limit || row.limitation, 500) || null,
  };
}

function normalizeStrategySteps(value) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n+/) : [];
  return rows.map(normalizeStrategyStep).filter(Boolean).slice(0, 8);
}

function storyMaterial(story = {}) {
  return {
    title: story.title,
    exam_track_id: story.exam_track_id,
    challenge_tags: story.challenge_tags,
    strategy_tags: story.strategy_tags,
    strategy_steps: story.strategy_steps,
    applicability_notes: story.applicability_notes,
    limitations: story.limitations,
    evidence_basis: story.evidence_basis,
    outcome_summary: story.outcome_summary,
    source_reference: story.source_reference,
    consent_verified: story.consent_verified,
    anonymized: story.anonymized,
  };
}

export function aylaSuccessStoryMaterialFingerprint(story = {}) {
  return JSON.stringify(storyMaterial(story));
}

export function normalizeAylaSuccessStoryDraft(input = {}, existing = {}, now = new Date().toISOString()) {
  for (const key of FORBIDDEN_INPUT_FIELDS) {
    if (cleanText(input[key], 40)) {
      throw storyError("Direct student identifiers and answer material cannot be stored in Success Story Training", "SUCCESS_STORY_DIRECT_IDENTIFIER_FORBIDDEN", { field: key });
    }
  }

  const examInput = input.exam_track_id ?? input.examTrackId ?? input.exam_track ?? input.exam ?? existing.exam_track_id;
  const examTrackId = examInput ? normalizeAylaShellExamTrack(examInput) : null;
  if (examInput && !examTrackId) {
    throw storyError("A supported exact exam track is required", "INVALID_SUCCESS_STORY_EXAM_TRACK");
  }
  const evidenceInput = input.evidence_basis ?? input.evidenceBasis ?? existing.evidence_basis ?? "";
  const evidenceBasis = cleanKey(evidenceInput);
  if (evidenceBasis && !AYLA_SUCCESS_STORY_EVIDENCE_TYPES.includes(evidenceBasis)) {
    throw storyError("Success story evidence_basis is not supported", "INVALID_SUCCESS_STORY_EVIDENCE_BASIS", { allowed: AYLA_SUCCESS_STORY_EVIDENCE_TYPES });
  }
  const status = STORY_STATES.has(cleanKey(existing.status)) ? cleanKey(existing.status) : "draft";
  const strategiesInput = input.strategy_steps ?? input.strategySteps ?? input.strategies;

  const normalized = {
    id: cleanText(existing.id || input.id, 160) || null,
    content_type: AYLA_SUCCESS_STORY_CONTENT_TYPE,
    category: "Success Story Training",
    title: cleanText(input.title ?? existing.title, 220),
    exam_track_id: examTrackId,
    challenge_tags: cleanList(input.challenge_tags ?? input.challengeTags ?? existing.challenge_tags, 20, 100),
    strategy_tags: cleanList(input.strategy_tags ?? input.strategyTags ?? existing.strategy_tags, 20, 100),
    strategy_steps: strategiesInput === undefined ? normalizeStrategySteps(existing.strategy_steps) : normalizeStrategySteps(strategiesInput),
    applicability_notes: cleanText(input.applicability_notes ?? input.applicabilityNotes ?? existing.applicability_notes, 1200),
    limitations: cleanText(input.limitations ?? input.cautions ?? existing.limitations, 1200),
    evidence_basis: evidenceBasis || null,
    outcome_summary: cleanText(input.outcome_summary ?? input.outcomeSummary ?? existing.outcome_summary, 1200),
    source_reference: cleanText(input.source_reference ?? input.sourceReference ?? existing.source_reference, 120),
    consent_verified: input.consent_verified !== undefined ? input.consent_verified === true : existing.consent_verified === true,
    anonymized: input.anonymized !== undefined ? input.anonymized === true : existing.anonymized === true,
    status,
    approval_status: status,
    active: status === "approved" && existing.active === true,
    is_active: status === "approved" && existing.is_active === true,
    enforce_in_ai: false,
    allowed_apps: ["aylamed_personal_tutor", "aylamed_roadmap"],
    governance_version: Math.max(1, Number(existing.governance_version || 1)),
    approval_version: Math.max(0, Number(existing.approval_version || 0)),
    approved_at: existing.approved_at || null,
    approved_by: existing.approved_by || null,
    approved_by_email: existing.approved_by_email || null,
    reviewed_at: existing.reviewed_at || null,
    reviewed_by: existing.reviewed_by || null,
    reviewed_by_email: existing.reviewed_by_email || null,
    review_note: cleanText(existing.review_note, 1000) || null,
    revoked_at: existing.revoked_at || null,
    archived_at: existing.archived_at || null,
    created_at: existing.created_at || now,
    created_by: existing.created_by || null,
    created_by_email: existing.created_by_email || null,
    updated_at: now,
    updated_by: existing.updated_by || null,
    updated_by_email: existing.updated_by_email || null,
  };
  const detectedPii = piiSignals(JSON.stringify(storyMaterial(normalized)));
  if (detectedPii.length) {
    throw storyError("Success Story Training accepts anonymized strategy data only", "SUCCESS_STORY_PII_DETECTED", { signals: detectedPii });
  }
  return normalized;
}

function piiSignals(value = "") {
  const text = String(value || "");
  const signals = [];
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) signals.push("email");
  if (/(?:\+?\d[\s().-]*){8,}/.test(text)) signals.push("phone");
  if (/\b(?:whatsapp|phone|email|address|student\s+name)\s*:/i.test(text)) signals.push("labeled_identifier");
  if (/https?:\/\//i.test(text)) signals.push("url");
  if (/\b(?:mr|mrs|ms|miss|dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text)) signals.push("named_person");
  return [...new Set(signals)];
}

function unsafeOutcomeClaims(value = "") {
  const text = String(value || "");
  const signals = [];
  if (/\b(?:guarantee(?:d)?|always\s+works?|sure\s+to|will\s+definitely)\b/i.test(text)) signals.push("guaranteed_outcome");
  if (/\b(?:copy|repeat|replicate)\s+(?:the\s+)?(?:same\s+)?(?:score|result|outcome)\b/i.test(text)) signals.push("replicated_outcome");
  if (/\b100\s*%\b/.test(text)) signals.push("absolute_claim");
  return [...new Set(signals)];
}

export function validateAylaSuccessStoryForApproval(story = {}) {
  const errors = [];
  if (cleanText(story.title, 220).length < 5) errors.push("title_required");
  if (!normalizeAylaShellExamTrack(story.exam_track_id)) errors.push("exact_exam_track_required");
  if (!cleanList(story.challenge_tags, 20, 100).length) errors.push("challenge_tags_required");
  if (!normalizeStrategySteps(story.strategy_steps).length) errors.push("strategy_steps_required");
  if (!AYLA_SUCCESS_STORY_EVIDENCE_TYPES.includes(cleanKey(story.evidence_basis))) errors.push("verified_evidence_basis_required");
  if (cleanText(story.outcome_summary, 1200).length < 10) errors.push("outcome_summary_required_for_admin_review");
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(cleanText(story.source_reference, 120))) errors.push("opaque_source_reference_required");
  if (story.consent_verified !== true) errors.push("consent_verification_required");
  if (story.anonymized !== true) errors.push("anonymization_required");

  const reviewText = JSON.stringify(storyMaterial(story));
  for (const signal of piiSignals(reviewText)) errors.push(`possible_pii_${signal}`);
  for (const signal of unsafeOutcomeClaims(reviewText)) errors.push(signal);
  if (errors.length) {
    throw storyError("Success story is not eligible for tutor consumption", "SUCCESS_STORY_APPROVAL_BLOCKED", { reasons: [...new Set(errors)] });
  }
  return { eligible: true, reasons: [] };
}

function reviewerIdentity(reviewer = {}) {
  const user = reviewer.user && typeof reviewer.user === "object" ? reviewer.user : reviewer;
  return {
    id: cleanText(user.id, 160) || null,
    email: cleanText(user.email, 240).toLowerCase() || null,
  };
}

export function reviewAylaSuccessStory(story = {}, review = {}, now = new Date().toISOString()) {
  const action = cleanKey(review.action);
  if (!REVIEW_ACTIONS.has(action)) throw storyError("Unsupported success story review action", "INVALID_SUCCESS_STORY_REVIEW_ACTION");
  const reviewer = reviewerIdentity(review.reviewer || review.actor || {});
  if (!reviewer.id) throw storyError("An authenticated reviewer is required", "SUCCESS_STORY_REVIEWER_REQUIRED", null, 401);
  const note = cleanText(review.note || review.review_note, 1000);
  const currentStatus = STORY_STATES.has(cleanKey(story.status)) ? cleanKey(story.status) : "draft";
  const next = { ...story };

  if (action === "submit") {
    if (!["draft", "rejected", "revoked"].includes(currentStatus)) throw storyError("Only draft, rejected, or revoked stories can be submitted", "INVALID_SUCCESS_STORY_STATE");
    if (!next.exam_track_id || !next.strategy_steps?.length || !next.challenge_tags?.length) throw storyError("Exam track, challenge tags, and strategy steps are required before review", "SUCCESS_STORY_SUBMISSION_INCOMPLETE");
    next.status = "needs_review";
  } else if (action === "approve") {
    validateAylaSuccessStoryForApproval(next);
    next.status = "approved";
    next.active = true;
    next.is_active = true;
    next.approved_at = now;
    next.approved_by = reviewer.id;
    next.approved_by_email = reviewer.email;
    next.approval_version = Math.max(0, Number(next.approval_version || 0)) + 1;
    next.revoked_at = null;
    next.archived_at = null;
  } else if (action === "reject") {
    if (!note) throw storyError("A review note is required when rejecting a success story", "SUCCESS_STORY_REVIEW_NOTE_REQUIRED");
    next.status = "rejected";
    next.active = false;
    next.is_active = false;
  } else if (action === "revoke") {
    if (currentStatus !== "approved") throw storyError("Only an approved success story can be revoked", "INVALID_SUCCESS_STORY_STATE");
    if (!note) throw storyError("A review note is required when revoking a success story", "SUCCESS_STORY_REVIEW_NOTE_REQUIRED");
    next.status = "revoked";
    next.active = false;
    next.is_active = false;
    next.revoked_at = now;
  } else if (action === "archive") {
    if (!note) throw storyError("A review note is required when archiving a success story", "SUCCESS_STORY_REVIEW_NOTE_REQUIRED");
    next.status = "archived";
    next.active = false;
    next.is_active = false;
    next.archived_at = now;
  }

  next.approval_status = next.status;
  next.enforce_in_ai = false;
  next.reviewed_at = now;
  next.reviewed_by = reviewer.id;
  next.reviewed_by_email = reviewer.email;
  next.review_note = note || null;
  next.governance_version = Math.max(1, Number(next.governance_version || 1)) + 1;
  next.updated_at = now;
  next.updated_by = reviewer.id;
  next.updated_by_email = reviewer.email;
  return next;
}

export function aylaSuccessStoryConsumptionEligibility(story = {}, examTrack = null) {
  const reasons = [];
  if (story.content_type !== AYLA_SUCCESS_STORY_CONTENT_TYPE) reasons.push("wrong_content_type");
  if (cleanKey(story.status || story.approval_status) !== "approved") reasons.push("not_approved");
  if (story.active !== true || story.is_active !== true) reasons.push("not_active");
  const storyExam = normalizeAylaShellExamTrack(story.exam_track_id);
  const requestedExam = examTrack ? normalizeAylaShellExamTrack(examTrack) : null;
  if (!storyExam) reasons.push("invalid_exam_track");
  if (requestedExam && storyExam !== requestedExam) reasons.push("exam_track_mismatch");
  if (!story.approved_at || !story.approved_by) reasons.push("approval_audit_missing");
  try {
    validateAylaSuccessStoryForApproval(story);
  } catch (error) {
    reasons.push(...(error.details?.reasons || [error.code || "approval_validation_failed"]));
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], exam_track_id: storyExam };
}

function tokens(value = "") {
  return [...new Set(String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((token) => token.length >= 3))];
}

function storySearchText(story = {}) {
  return [story.challenge_tags, story.strategy_tags, story.strategy_steps, story.applicability_notes, story.limitations].flat(Infinity).map((value) => typeof value === "object" ? Object.values(value).join(" ") : value).join(" ");
}

function scrubOutputText(value = "", max = 700) {
  return cleanText(value, max)
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted]")
    .replace(/(?:\+?\d[\s().-]*){8,}/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted]");
}

export function sanitizeAylaSuccessStoryStrategy(story = {}, score = 0) {
  const steps = normalizeStrategySteps(story.strategy_steps).slice(0, 5).map((step) => ({
    id: step.id,
    action: scrubOutputText(step.action, 500),
    why_it_helped: step.why_it_helped ? scrubOutputText(step.why_it_helped, 700) : null,
    use_when: step.use_when ? scrubOutputText(step.use_when, 500) : null,
    caution: step.caution ? scrubOutputText(step.caution, 500) : null,
  }));
  const challengeTags = cleanList(story.challenge_tags, 12, 100);
  return {
    strategy_id: cleanText(story.id, 160),
    pattern_label: challengeTags[0] ? `${scrubOutputText(challengeTags[0], 100)} strategy pattern` : "Approved strategy pattern",
    exam_track_id: normalizeAylaShellExamTrack(story.exam_track_id),
    challenge_tags: challengeTags.map((tag) => scrubOutputText(tag, 100)),
    strategy_tags: cleanList(story.strategy_tags, 12, 100).map((tag) => scrubOutputText(tag, 100)),
    strategy_steps: steps,
    applicability_notes: scrubOutputText(story.applicability_notes, 900) || null,
    limitations: scrubOutputText(story.limitations, 900) || null,
    evidence_basis: cleanKey(story.evidence_basis),
    approval_version: Math.max(1, Number(story.approval_version || 1)),
    relevance_score: Math.max(0, Number(score || 0)),
    source: "CRM AI Training Center — approved anonymized success story",
    advisory_only: true,
    personal_data_included: false,
    outcome_summary_included: false,
    outcome_promised: false,
    roadmap_authority: "existing_adaptive_roadmap",
  };
}

export function selectAylaSuccessStoryStrategies({ stories = [], examTrack, focus = [], limit = 3 } = {}) {
  const requestedExam = normalizeAylaShellExamTrack(examTrack);
  if (!requestedExam) return [];
  const focusTokens = tokens(Array.isArray(focus) ? focus.join(" ") : focus);
  return (Array.isArray(stories) ? stories : [])
    .map((story) => ({ story, eligibility: aylaSuccessStoryConsumptionEligibility(story, requestedExam) }))
    .filter((row) => row.eligibility.eligible)
    .map(({ story }) => {
      const haystack = storySearchText(story).toLowerCase();
      let score = 0;
      for (const token of focusTokens) {
        if (cleanList(story.challenge_tags).some((tag) => tag.toLowerCase().includes(token))) score += 12;
        if (cleanList(story.strategy_tags).some((tag) => tag.toLowerCase().includes(token))) score += 8;
        if (haystack.includes(token)) score += 2;
      }
      return { story, score };
    })
    .filter((row) => !focusTokens.length || row.score > 0)
    .sort((left, right) => right.score - left.score || String(right.story.approved_at || "").localeCompare(String(left.story.approved_at || "")) || String(left.story.id || "").localeCompare(String(right.story.id || "")))
    .slice(0, Math.max(1, Math.min(5, Number(limit || 3))))
    .map(({ story, score }) => sanitizeAylaSuccessStoryStrategy(story, score));
}

export function sanitizeAylaSuccessStoryForAdmin(story = {}) {
  const eligibility = aylaSuccessStoryConsumptionEligibility(story, story.exam_track_id);
  return {
    ...story,
    consumption_eligible: eligibility.eligible,
    consumption_blockers: eligibility.reasons,
    student_personal_data_stored: false,
    outcome_shared_with_tutor: false,
  };
}
