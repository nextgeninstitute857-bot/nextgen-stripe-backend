const CDM_CONFIDENCE_VALUES = new Set(["confident", "not_sure"]);
const CDM_REVIEW_VALUES = new Set(["correct", "not_acceptable", "dangerous_act"]);
const TERMINAL_CDM_SESSION_STATES = new Set(["completed", "abandoned"]);

export const AYLA_CDM_STATE_COLLECTIONS = Object.freeze([
  "aylaCdmSessions",
  "aylaCdmEvents",
  "aylaCdmAttempts",
]);

function cdmError(message, statusCode = 400, code = "INVALID_CDM_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanString(value = "", max = 400) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, max);
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw cdmError("A valid timestamp is required");
  return date.toISOString();
}

function sessionStep(session = {}, stepRef = "") {
  const ref = cleanString(stepRef, 100);
  return (Array.isArray(session.steps) ? session.steps : [])
    .find((row) => String(row?.ref || "") === ref) || null;
}

function reviewedStepCount(session = {}) {
  const reviews = session.reviews && typeof session.reviews === "object" ? session.reviews : {};
  return (Array.isArray(session.steps) ? session.steps : [])
    .filter((row) => Object.prototype.hasOwnProperty.call(reviews, String(row.ref || "")))
    .length;
}

export function normalizeAylaCdmConfidence(value = "") {
  const clean = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    sure: "confident",
    know: "confident",
    "i_know_this": "confident",
    unsure: "not_sure",
    uncertain: "not_sure",
    "i_dont_know_this": "not_sure",
    "i_don_t_know_this": "not_sure",
  };
  const normalized = aliases[clean] || clean;
  if (!CDM_CONFIDENCE_VALUES.has(normalized)) {
    throw cdmError("Confidence must be confident or not_sure", 400, "INVALID_CDM_CONFIDENCE");
  }
  return normalized;
}

export function normalizeAylaCdmReviewMark(value = "") {
  const clean = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    acceptable: "correct",
    matched: "correct",
    incorrect: "not_acceptable",
    not_listed: "not_acceptable",
    unacceptable: "not_acceptable",
    dangerous: "dangerous_act",
  };
  const normalized = aliases[clean] || clean;
  if (!CDM_REVIEW_VALUES.has(normalized)) {
    throw cdmError(
      "Each response must be marked correct, not_acceptable, or dangerous_act",
      400,
      "INVALID_CDM_REVIEW_MARK",
    );
  }
  return normalized;
}

export function normalizeAylaCdmResponses(value = []) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n/);
  const responses = raw
    .map((item) => cleanString(item, 500))
    .filter(Boolean);
  if (!responses.length) {
    throw cdmError("Enter at least one clinical response", 400, "CDM_RESPONSE_REQUIRED");
  }
  if (responses.length > 20) {
    throw cdmError("A CDM step cannot contain more than 20 response lines", 400, "CDM_RESPONSE_LIMIT");
  }
  const unique = new Set(responses.map((item) => item.toLowerCase()));
  if (unique.size !== responses.length) {
    throw cdmError("Enter each clinical response only once", 400, "DUPLICATE_CDM_RESPONSE");
  }
  return responses;
}

export function createAylaCdmSession({
  id,
  userId,
  studentId,
  examTrack,
  caseId,
  caseTitle = "",
  steps = [],
  origin = "personal",
  roadmapAssignmentId = null,
  entitlement = null,
  now = new Date(),
} = {}) {
  const cleanSteps = [];
  const seenRefs = new Set();
  const seenQuestionIds = new Set();
  for (const [index, row] of (Array.isArray(steps) ? steps : []).entries()) {
    const ref = cleanString(row?.ref, 100);
    const contentQuestionId = cleanString(
      row?.contentQuestionId || row?.content_question_id || row?.id,
      100,
    );
    if (!ref || !contentQuestionId || seenRefs.has(ref) || seenQuestionIds.has(contentQuestionId)) continue;
    seenRefs.add(ref);
    seenQuestionIds.add(contentQuestionId);
    cleanSteps.push({
      ref,
      contentQuestionId,
      position: index + 1,
      maxResponses: Math.max(1, Math.min(20, Math.trunc(Number(
        row?.maxResponses || row?.max_responses || 1,
      ) || 1))),
    });
  }
  if (!id || !userId || !studentId || !examTrack || !caseId) {
    throw cdmError("Session identity, owner, student, exam track, and case are required");
  }
  if (!cleanSteps.length) throw cdmError("No approved CDM steps were selected", 409, "NO_ELIGIBLE_CDM_STEPS");
  const startedAt = isoTimestamp(now);
  return {
    id: cleanString(id, 120),
    userId: cleanString(userId, 120),
    studentId: cleanString(studentId, 120),
    examTrack: cleanString(examTrack, 80),
    caseId: cleanString(caseId, 120),
    caseTitle: cleanString(caseTitle || "Clinical decision case", 240),
    destination: "aylamed_cdm",
    interactionFormat: "legacy_cdm_write_in_v1",
    origin: origin === "roadmap" ? "roadmap" : "personal",
    roadmapAssignmentId: roadmapAssignmentId ? cleanString(roadmapAssignmentId, 120) : null,
    status: "in_progress",
    steps: cleanSteps,
    stepCount: cleanSteps.length,
    responses: {},
    reviews: {},
    respondedStepCount: 0,
    reviewedStepCount: 0,
    currentStepIndex: 0,
    summary: null,
    scorePercent: null,
    serverVerifiedScore: false,
    entitlementSnapshot: entitlement && typeof entitlement === "object"
      ? {
          entitlement_type: entitlement.entitlement_type || null,
          enrollment_id: entitlement.enrollment_id || null,
          plan_id: entitlement.plan_id || null,
          expires_at: entitlement.expires_at || null,
        }
      : null,
    startedAt,
    updatedAt: startedAt,
  };
}

function requireActiveSequentialStep(session, stepRef, { allowReviewed = false } = {}) {
  if (!session || TERMINAL_CDM_SESSION_STATES.has(String(session.status || ""))) {
    throw cdmError("This CDM session is no longer active", 409, "CDM_SESSION_NOT_ACTIVE");
  }
  const step = sessionStep(session, stepRef);
  if (!step) throw cdmError("Step does not belong to this CDM session", 404, "CDM_STEP_NOT_FOUND");
  const reviews = session.reviews && typeof session.reviews === "object" ? session.reviews : {};
  if (!allowReviewed && Object.prototype.hasOwnProperty.call(reviews, step.ref)) {
    throw cdmError("This CDM step has already been reviewed", 409, "CDM_STEP_ALREADY_REVIEWED");
  }
  const expected = Math.max(0, reviewedStepCount(session));
  if (Number(step.position || 1) !== expected + 1) {
    throw cdmError(
      "Complete and self-review the current CDM step before opening the next one",
      409,
      "CDM_STEP_SEQUENCE_LOCKED",
    );
  }
  return step;
}

export function recordAylaCdmResponse(session, {
  stepRef,
  responses,
  confidence,
  now = new Date(),
} = {}) {
  const requestedStep = sessionStep(session, stepRef);
  if (!requestedStep) throw cdmError("Step does not belong to this CDM session", 404, "CDM_STEP_NOT_FOUND");
  const existing = session.responses && typeof session.responses === "object"
    ? session.responses[requestedStep.ref]
    : null;
  if (existing) return { session, response: existing, replayed: true };
  const step = requireActiveSequentialStep(session, stepRef);
  const normalizedResponses = normalizeAylaCdmResponses(responses);
  const recordedAt = isoTimestamp(now);
  const response = {
    stepRef: step.ref,
    responses: normalizedResponses,
    responseCount: normalizedResponses.length,
    maxResponses: step.maxResponses,
    overLimit: normalizedResponses.length > step.maxResponses,
    confidence: normalizeAylaCdmConfidence(confidence),
    lockedAt: recordedAt,
  };
  session.responses = { ...(session.responses || {}), [step.ref]: response };
  session.respondedStepCount = Object.keys(session.responses).length;
  session.updatedAt = recordedAt;
  return { session, response, replayed: false };
}

export function recordAylaCdmSelfReview(session, {
  stepRef,
  marks = [],
  note = "",
  now = new Date(),
} = {}) {
  const requestedStep = sessionStep(session, stepRef);
  if (!requestedStep) throw cdmError("Step does not belong to this CDM session", 404, "CDM_STEP_NOT_FOUND");
  const existing = session.reviews && typeof session.reviews === "object"
    ? session.reviews[requestedStep.ref]
    : null;
  if (existing) return { session, review: existing, replayed: true };
  const step = requireActiveSequentialStep(session, stepRef);
  const response = session.responses?.[step.ref];
  if (!response) {
    throw cdmError("Lock your clinical responses before viewing and marking the key", 409, "CDM_RESPONSE_NOT_LOCKED");
  }
  const normalizedMarks = (Array.isArray(marks) ? marks : []).map(normalizeAylaCdmReviewMark);
  if (normalizedMarks.length !== response.responses.length) {
    throw cdmError(
      "Self-mark every submitted response before continuing",
      400,
      "CDM_REVIEW_COUNT_MISMATCH",
    );
  }
  const reviewedAt = isoTimestamp(now);
  const review = {
    stepRef: step.ref,
    marks: response.responses.map((text, index) => ({ response: text, mark: normalizedMarks[index] })),
    correctCount: normalizedMarks.filter((mark) => mark === "correct").length,
    notAcceptableCount: normalizedMarks.filter((mark) => mark === "not_acceptable").length,
    dangerousActCount: normalizedMarks.filter((mark) => mark === "dangerous_act").length,
    needsRevision: response.overLimit
      || response.confidence === "not_sure"
      || normalizedMarks.some((mark) => mark !== "correct"),
    note: cleanString(note, 2_000),
    reviewedAt,
  };
  session.reviews = { ...(session.reviews || {}), [step.ref]: review };
  session.reviewedStepCount = Object.keys(session.reviews).length;
  session.currentStepIndex = Math.min(session.stepCount - 1, session.reviewedStepCount);
  session.updatedAt = reviewedAt;
  return { session, review, replayed: false };
}

export function canCompleteAylaCdmSession(session = {}) {
  const steps = Array.isArray(session.steps) ? session.steps : [];
  const reviews = session.reviews && typeof session.reviews === "object" ? session.reviews : {};
  return steps.length > 0 && steps.every((step) => Object.prototype.hasOwnProperty.call(reviews, step.ref));
}

export function finalizeAylaCdmSession(session, now = new Date()) {
  if (String(session?.status || "") === "completed") return { session, replayed: true };
  if (!canCompleteAylaCdmSession(session)) {
    throw cdmError(
      "Submit and self-review every CDM step before completing the case",
      409,
      "CDM_CASE_INCOMPLETE",
    );
  }
  const responses = Object.values(session.responses || {});
  const reviews = Object.values(session.reviews || {});
  const completedAt = isoTimestamp(now);
  session.status = "completed";
  session.completedAt = completedAt;
  session.updatedAt = completedAt;
  session.summary = {
    stepsCompleted: reviews.length,
    responseCount: responses.reduce((sum, row) => sum + Number(row.responseCount || 0), 0),
    correctCount: reviews.reduce((sum, row) => sum + Number(row.correctCount || 0), 0),
    notAcceptableCount: reviews.reduce((sum, row) => sum + Number(row.notAcceptableCount || 0), 0),
    dangerousActCount: reviews.reduce((sum, row) => sum + Number(row.dangerousActCount || 0), 0),
    overLimitSteps: responses.filter((row) => row.overLimit === true).length,
    notSureSteps: responses.filter((row) => row.confidence === "not_sure").length,
    revisionNeeded: reviews.some((row) => row.needsRevision === true),
    evidenceType: "student_self_reviewed_legacy_cdm_practice",
    scorePercent: null,
    serverVerifiedScore: false,
  };
  session.scorePercent = null;
  session.serverVerifiedScore = false;
  return { session, replayed: false };
}

export function cdmRoadmapAssignmentCaseId(assignment = {}) {
  const direct = cleanString(
    assignment.cdmCaseId
      || assignment.cdm_case_id
      || assignment.items?.[0]?.cdmCaseId
      || assignment.items?.[0]?.cdm_case_id
      || "",
    120,
  );
  if (direct) return direct;
  const category = String(assignment.category || assignment.type || "").trim().toLowerCase();
  if (!["cdm_case", "legacy_cdm_case"].includes(category)) return "";
  return cleanString(
    assignment.resourceIds?.[0]
      || assignment.resource_ids?.[0]
      || assignment.items?.[0]?.resourceId
      || assignment.items?.[0]?.resource_id
      || "",
    120,
  );
}

export function cdmRoadmapAssignmentEligible(assignment = {}) {
  const category = String(assignment.category || assignment.type || "").trim().toLowerCase();
  return ["cdm_case", "legacy_cdm_case"].includes(category)
    && Boolean(cdmRoadmapAssignmentCaseId(assignment));
}

export function cdmRoadmapSessionMatchesAssignment(session = {}, assignment = {}) {
  return String(session.caseId || "") === cdmRoadmapAssignmentCaseId(assignment)
    && String(session.roadmapAssignmentId || "") === String(assignment.id || "");
}

export function sanitizeAylaCdmSession(session = {}) {
  return {
    id: session.id,
    exam_track: session.examTrack,
    case_id: session.caseId,
    case_title: session.caseTitle,
    interaction_format: session.interactionFormat,
    origin: session.origin,
    roadmap_assignment_id: session.roadmapAssignmentId || null,
    status: session.status,
    step_count: Number(session.stepCount || 0),
    responded_step_count: Number(session.respondedStepCount || 0),
    reviewed_step_count: Number(session.reviewedStepCount || 0),
    current_step_index: Number(session.currentStepIndex || 0),
    summary: session.summary || null,
    score_percent: null,
    server_verified_score: false,
    started_at: session.startedAt || null,
    completed_at: session.completedAt || null,
    updated_at: session.updatedAt || null,
  };
}

export function cdmSessionHistoryRow(session = {}) {
  return {
    ...sanitizeAylaCdmSession(session),
    needs_revision: session.summary?.revisionNeeded === true,
  };
}
