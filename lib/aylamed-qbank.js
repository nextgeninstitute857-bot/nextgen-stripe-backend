import {
  normalizeAylaRegistryExamTrack,
  resolveAylaExamFeatureEntitlement,
} from "./aylamed-student-shell.js";

const QBANK_MODES = new Set(["tutor", "test"]);
const QBANK_PURPOSES = new Set(["practice", "baseline_diagnostic"]);
const TERMINAL_SESSION_STATES = new Set(["submitted", "abandoned"]);

export const AYLA_QBANK_STATE_COLLECTIONS = Object.freeze([
  "aylaQbankSessions",
  "aylaQbankBookmarks",
  "aylaQbankNotes",
  "aylaQbankEvents",
  "aylaRevisionQueue",
  "aylaQuestionAttempts",
  "aylaActivityHistory",
]);

function qbankError(message, statusCode = 400, code = "INVALID_QBANK_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanString(value = "", max = 160) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function itemTimestamp(item = {}) {
  const value = item.updatedAt || item.updated_at || item.submittedAt || item.createdAt || item.created_at || "";
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function mergeConcurrentAylaQbankCollection(latest = {}, incoming = {}) {
  const currentRows = latest && typeof latest === "object" && !Array.isArray(latest) ? latest : {};
  const incomingRows = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...currentRows };
  for (const [id, item] of Object.entries(incomingRows)) {
    const current = merged[id];
    if (!current || itemTimestamp(item) >= itemTimestamp(current)) merged[id] = item;
  }
  return merged;
}

export function normalizeAylaQbankExamTrack(value = "") {
  return normalizeAylaRegistryExamTrack(value);
}

export function normalizeAylaQbankMode(value = "tutor") {
  const clean = String(value || "tutor").trim().toLowerCase().replace(/[\s_-]+/g, "-");
  if (QBANK_MODES.has(clean)) return clean;
  if (["assessment", "assessment-mode", "exam", "timed", "test-mode"].includes(clean)) return "test";
  if (["tutor", "tutor-mode", "practice"].includes(clean)) return "tutor";
  throw qbankError("QBank mode must be tutor or test", 400, "INVALID_QBANK_MODE");
}

export function normalizeAylaQbankPurpose(value = "practice") {
  const clean = String(value || "practice").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (QBANK_PURPOSES.has(clean)) return clean;
  if (["diagnostic", "take_diagnostic", "baseline", "baseline_test", "onboarding_diagnostic"].includes(clean)) return "baseline_diagnostic";
  if (["qbank", "personal", "roadmap", "study"].includes(clean)) return "practice";
  throw qbankError("QBank purpose must be practice or baseline diagnostic", 400, "INVALID_QBANK_PURPOSE");
}

export function normalizeAylaQbankFilters(input = {}) {
  return {
    system_key: cleanString(input.system_key ?? input.systemKey, 120),
    subsystem_key: cleanString(input.subsystem_key ?? input.subsystemKey, 120),
    topic_key: cleanString(input.topic_key ?? input.topicKey, 180),
    subtopic_key: cleanString(input.subtopic_key ?? input.subtopicKey, 180),
  };
}

export function qbankRoadmapAssignmentQuestionIds(assignment = {}) {
  const contentQuestionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = cleanString(value, 100);
    if (!contentQuestionIdPattern.test(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  const items = Array.isArray(assignment.items) ? assignment.items : [];
  for (const item of items) {
    add(
      item?.contentQuestionId
      || item?.content_question_id
      || item?.resourceId
      || item?.resource_id
      || item?.id,
    );
  }
  if (!ids.length) {
    for (const value of Array.isArray(assignment.resourceIds)
      ? assignment.resourceIds
      : Array.isArray(assignment.resource_ids)
        ? assignment.resource_ids
        : []) {
      add(value);
    }
  }
  if (!ids.length) add(assignment.contentQuestionId || assignment.content_question_id);

  return ids.slice(0, 200);
}

export function qbankRoadmapSessionMatchesAssignment(session = {}, assignment = {}) {
  const sessionIds = (Array.isArray(session.questions) ? session.questions : [])
    .map((row) => cleanString(row?.contentQuestionId || row?.content_question_id, 100))
    .filter(Boolean);
  const assignmentIds = qbankRoadmapAssignmentQuestionIds(assignment);
  return assignmentIds.length > 0
    && sessionIds.length === assignmentIds.length
    && sessionIds.every((id, index) => id === assignmentIds[index]);
}

export function canSubmitAylaQbankRoadmapSession(session = {}) {
  if (String(session.origin || "personal") !== "roadmap") return true;
  const questions = Array.isArray(session.questions) ? session.questions : [];
  const answers = session.answers && typeof session.answers === "object" ? session.answers : {};
  return questions.length > 0
    && questions.every((row) => Object.prototype.hasOwnProperty.call(answers, String(row?.ref || "")));
}

export function resolveAylaQbankEntitlement({
  enrollments = [],
  plansById = {},
  userId,
  student = {},
  requestedExamTrack,
  feature = "qbank",
  defaultStudentId = null,
  now = Date.now(),
} = {}) {
  const examTrack = normalizeAylaQbankExamTrack(requestedExamTrack);
  const profileExamTrack = normalizeAylaQbankExamTrack(
    student.examTrackId || student.exam_track_id || student.examTrack || student.exam_track || student.exam,
  );
  if (!examTrack) {
    return { allowed: false, reason: "invalid_exam_track", exam_track: null, profile_exam_track: profileExamTrack };
  }
  const access = resolveAylaExamFeatureEntitlement({
    enrollments,
    plansById,
    userId,
    requestedExamTrack: examTrack,
    feature,
    legacyExamTrack: profileExamTrack,
    legacyStudentId: student.id || student.studentId || student.student_id || null,
    defaultStudentId,
    enforceStudentScope: true,
    now,
  });

  return {
    allowed: access.allowed,
    reason: access.reason,
    exam_track: access.exam_track,
    exam_track_id: access.exam_track_id,
    profile_exam_track: profileExamTrack,
    entitlement_type: access.entitlement_type,
    enrollment_id: access.enrollment_id,
    plan_id: access.plan_id,
    expires_at: access.expires_at,
    explicitly_scoped: access.explicitly_scoped,
    enabled_features: access.enabled_features,
  };
}

export function requireAylaQbankEntitlement(input = {}) {
  const access = resolveAylaQbankEntitlement(input);
  if (access.allowed) return access;
  const messages = {
    invalid_exam_track: "A supported QBank exam track is required",
    no_active_exam_entitlement: "No active AylaMed enrollment grants access to this exam track",
    feature_not_included: "QBank is not included in the active AylaMed plan for this exam track",
  };
  throw qbankError(messages[access.reason] || "AylaMed QBank access is not available", 403, "QBANK_ACCESS_DENIED");
}

export function createAylaQbankSession({
  id,
  userId,
  studentId,
  examTrack,
  mode = "tutor",
  purpose = "practice",
  questions = [],
  filters = {},
  blockSize = 40,
  origin = "personal",
  roadmapAssignmentId = null,
  timeLimitMinutes = null,
  entitlement = null,
  now = new Date(),
} = {}) {
  const cleanExamTrack = normalizeAylaQbankExamTrack(examTrack);
  if (!id || !userId || !studentId || !cleanExamTrack) throw qbankError("Session identity, owner, student, and exam track are required");
  const cleanMode = normalizeAylaQbankMode(mode);
  const cleanPurpose = normalizeAylaQbankPurpose(purpose);
  if (cleanPurpose === "baseline_diagnostic" && cleanMode !== "test") {
    throw qbankError("A baseline diagnostic must use sealed test mode", 400, "DIAGNOSTIC_REQUIRES_TEST_MODE");
  }
  const cleanQuestions = [];
  const seenRefs = new Set();
  const seenContentIds = new Set();
  for (const row of Array.isArray(questions) ? questions : []) {
    const ref = cleanString(row?.ref, 100);
    const contentQuestionId = cleanString(row?.contentQuestionId || row?.content_question_id, 100);
    if (!ref || !contentQuestionId || seenRefs.has(ref) || seenContentIds.has(contentQuestionId)) continue;
    seenRefs.add(ref);
    seenContentIds.add(contentQuestionId);
    cleanQuestions.push({ ref, contentQuestionId });
  }
  if (!cleanQuestions.length) throw qbankError("No eligible questions were selected", 409, "NO_ELIGIBLE_QBANK_QUESTIONS");
  if (cleanQuestions.length > 200) throw qbankError("A QBank session cannot contain more than 200 questions");

  const safeBlockSize = Math.max(1, Math.min(40, Math.trunc(Number(blockSize) || 40)));
  const startedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const blocks = [];
  for (let index = 0; index < cleanQuestions.length; index += safeBlockSize) {
    blocks.push({
      id: `${id}:B${blocks.length + 1}`,
      index: blocks.length,
      questionRefs: cleanQuestions.slice(index, index + safeBlockSize).map((row) => row.ref),
    });
  }
  const requestedLimit = Number(timeLimitMinutes);
  const safeTimeLimit = cleanMode === "test" && Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.min(600, Math.round(requestedLimit)))
    : null;

  return {
    id: cleanString(id, 120),
    userId: cleanString(userId, 120),
    studentId: cleanString(studentId, 120),
    examTrack: cleanExamTrack,
    destination: "aylamed_qbank",
    mode: cleanMode,
    purpose: cleanPurpose,
    origin: origin === "roadmap" ? "roadmap" : "personal",
    roadmapAssignmentId: roadmapAssignmentId ? cleanString(roadmapAssignmentId, 120) : null,
    status: "in_progress",
    filters: normalizeAylaQbankFilters(filters),
    questionCount: cleanQuestions.length,
    questions: cleanQuestions,
    blocks,
    blockSize: safeBlockSize,
    timeLimitMinutes: safeTimeLimit,
    answers: {},
    marks: {},
    answeredCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    scorePercent: null,
    entitlementSnapshot: entitlement ? {
      type: entitlement.entitlement_type || null,
      enrollmentId: entitlement.enrollment_id || null,
      planId: entitlement.plan_id || null,
    } : null,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
    submittedAt: null,
  };
}

export function qbankSessionQuestion(session = {}, questionRef = "") {
  const ref = cleanString(questionRef, 100);
  return (Array.isArray(session.questions) ? session.questions : []).find((row) => String(row.ref) === ref) || null;
}

export function recordAylaQbankAnswer(session = {}, {
  questionRef,
  selectedAnswerId,
  correctAnswerId,
  elapsedMs = null,
  now = new Date(),
} = {}) {
  if (TERMINAL_SESSION_STATES.has(String(session.status))) throw qbankError("This QBank session is already closed", 409, "QBANK_SESSION_CLOSED");
  const question = qbankSessionQuestion(session, questionRef);
  if (!question) throw qbankError("Question does not belong to this QBank session", 404, "QBANK_QUESTION_NOT_FOUND");
  const selected = Number(selectedAnswerId);
  const correct = Number(correctAnswerId);
  if (!Number.isInteger(selected) || !Number.isInteger(correct)) throw qbankError("A valid answer choice is required");

  const existing = session.answers?.[question.ref];
  if (existing) {
    if (Number(existing.selectedAnswerId) === selected) return { session, answer: existing, replayed: true };
    throw qbankError("This answer is locked and cannot be changed", 409, "QBANK_ANSWER_LOCKED");
  }

  const answeredAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const answer = {
    questionRef: question.ref,
    contentQuestionId: question.contentQuestionId,
    selectedAnswerId: selected,
    correctAnswerId: correct,
    correct: selected === correct,
    elapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(Number(elapsedMs)))) : null,
    answeredAt,
  };
  const answers = { ...(session.answers || {}), [question.ref]: answer };
  const rows = Object.values(answers);
  const next = {
    ...session,
    answers,
    answeredCount: rows.length,
    correctCount: rows.filter((row) => row.correct === true).length,
    incorrectCount: rows.filter((row) => row.correct === false).length,
    updatedAt: answeredAt,
  };
  return { session: next, answer, replayed: false };
}

export function setAylaQbankQuestionMark(session = {}, questionRef = "", marked = true, now = new Date()) {
  if (TERMINAL_SESSION_STATES.has(String(session.status))) throw qbankError("This QBank session is already closed", 409, "QBANK_SESSION_CLOSED");
  const question = qbankSessionQuestion(session, questionRef);
  if (!question) throw qbankError("Question does not belong to this QBank session", 404, "QBANK_QUESTION_NOT_FOUND");
  const marks = { ...(session.marks || {}) };
  if (marked) marks[question.ref] = (now instanceof Date ? now : new Date(now)).toISOString();
  else delete marks[question.ref];
  return { ...session, marks, updatedAt: (now instanceof Date ? now : new Date(now)).toISOString() };
}

export function finalizeAylaQbankSession(session = {}, now = new Date()) {
  if (String(session.status) === "submitted") return { session, replayed: true };
  if (String(session.status) === "abandoned") throw qbankError("This QBank session was abandoned", 409, "QBANK_SESSION_CLOSED");
  const submittedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const total = Math.max(0, Number(session.questionCount || session.questions?.length || 0));
  const answers = Object.values(session.answers || {});
  const correctCount = answers.filter((row) => row.correct === true).length;
  const answeredCount = answers.length;
  const scorePercent = total ? Math.round((correctCount / total) * 10000) / 100 : 0;
  const startedMs = new Date(session.startedAt || session.createdAt || submittedAt).getTime();
  const submittedMs = new Date(submittedAt).getTime();
  return {
    replayed: false,
    session: {
      ...session,
      status: "submitted",
      answeredCount,
      correctCount,
      incorrectCount: Math.max(0, total - correctCount),
      unansweredCount: Math.max(0, total - answeredCount),
      scorePercent,
      durationMs: Number.isFinite(startedMs) ? Math.max(0, submittedMs - startedMs) : null,
      submittedAt,
      updatedAt: submittedAt,
    },
  };
}

export function canRevealAylaQbankAnswer(session = {}, questionRef = "") {
  if (String(session.status) === "submitted") return true;
  return String(session.mode) === "tutor" && Boolean(session.answers?.[String(questionRef)]);
}

export function sanitizeAylaQbankQuestion(question = {}, { session = {}, questionRef = "", bookmark = null, note = null, revision = null } = {}) {
  const reveal = canRevealAylaQbankAnswer(session, questionRef);
  const answer = session.answers?.[String(questionRef)] || null;
  const revisionReasons = Array.isArray(revision?.reasons) ? revision.reasons : [];
  const studentAddedRevision = revisionReasons.some((reason) => reason !== "incorrect_answer");
  const media = (Array.isArray(question.media) ? question.media : [])
    .filter((item) => reveal || String(item.placement || "explanation") !== "explanation")
    .map((item) => ({
      id: item.id,
      ref: item.ref || null,
      placement: item.placement || "explanation",
      kind: item.kind || (String(item.content_type || "").startsWith("audio/") ? "audio" : "image"),
      content_type: item.content_type || "image/*",
      url: item.url || null,
      expires_in_seconds: item.expires_in_seconds || null,
    }));
  const videos = (Array.isArray(question.videos) ? question.videos : [])
    .filter((item) => reveal || String(item.placement || "explanation") !== "explanation")
    .map((item) => ({
      id: item.id,
      ref: item.ref || null,
      placement: item.placement || "explanation",
      provider: "vimeo",
      embed_url: item.embed_url || null,
    }));
  const choices = (Array.isArray(question.answers) ? question.answers : []).map((row) => ({
    answer_id: Number(row.answer_id ?? row.answerId),
    text_html: String(row.text_html ?? row.textHtml ?? ""),
  }));
  const result = {
    question_ref: String(questionRef),
    display_question_id: question.display_question_id ?? null,
    question_identifiers: question.question_identifiers || null,
    source_label: question.source_label ?? null,
    title: question.title || "",
    question_html: question.question_html || "",
    answers: choices,
    taxonomy: {
      system_key: question.system_key || question.taxonomy?.system_key || "",
      subsystem_key: question.subsystem_key || question.taxonomy?.subsystem_key || "",
      topic_key: question.topic_key || question.taxonomy?.topic_key || "",
      subtopic_key: question.subtopic_key || question.taxonomy?.subtopic_key || "",
      ...(question.taxonomy?.labels && typeof question.taxonomy.labels === "object" ? { labels: question.taxonomy.labels } : {}),
    },
    system_key: question.system_key || question.taxonomy?.system_key || "",
    subsystem_key: question.subsystem_key || question.taxonomy?.subsystem_key || "",
    topic_key: question.topic_key || question.taxonomy?.topic_key || "",
    subtopic_key: question.subtopic_key || question.taxonomy?.subtopic_key || "",
    media,
    videos,
    marked: Boolean(session.marks?.[String(questionRef)]),
    bookmarked: Boolean(bookmark && !bookmark.deletedAt),
    note: note && !note.deletedAt ? { id: note.id, text: note.text || "", updated_at: note.updatedAt || note.createdAt || null } : null,
    in_revision: Boolean(revision && (reveal || studentAddedRevision) && !["removed", "completed"].includes(String(revision.status || "due").toLowerCase())),
    answered: Boolean(answer),
    selected_answer_id: answer ? Number(answer.selectedAnswerId) : null,
    result: reveal && answer ? { correct: Boolean(answer.correct), answered_at: answer.answeredAt || null } : null,
    correct_answer_id: reveal ? Number(answer?.correctAnswerId ?? question.correct_answer_id) : null,
    explanation_html: reveal ? String(question.explanation_html || "") : null,
    explanation_available: reveal,
  };
  return result;
}

export function sanitizeAylaQbankSession(session = {}, { includeInternal = false } = {}) {
  const questions = (Array.isArray(session.questions) ? session.questions : []).map((row) => (
    includeInternal ? { question_ref: row.ref, content_question_id: row.contentQuestionId } : { question_ref: row.ref }
  ));
  return {
    id: session.id,
    student_id: session.studentId,
    exam_track: session.examTrack,
    mode: session.mode,
    purpose: normalizeAylaQbankPurpose(session.purpose || "practice"),
    origin: session.origin || "personal",
    roadmap_assignment_id: session.roadmapAssignmentId || null,
    status: session.status,
    filters: session.filters || {},
    question_count: Number(session.questionCount || questions.length),
    questions,
    blocks: (Array.isArray(session.blocks) ? session.blocks : []).map((block) => ({
      id: block.id,
      index: block.index,
      question_refs: Array.isArray(block.questionRefs) ? block.questionRefs : [],
    })),
    block_size: session.blockSize || null,
    time_limit_minutes: session.timeLimitMinutes || null,
    diagnostic_coverage: session.purpose === "baseline_diagnostic" && session.diagnosticCoverage
      ? {
          available_system_count: Number(session.diagnosticCoverage.availableSystemCount || 0),
          selected_system_count: Number(session.diagnosticCoverage.selectedSystemCount || 0),
          selected_system_keys: Array.isArray(session.diagnosticCoverage.selectedSystemKeys)
            ? session.diagnosticCoverage.selectedSystemKeys.map((value) => cleanString(value, 120)).filter(Boolean)
            : [],
        }
      : null,
    answered_count: Number(session.answeredCount || 0),
    correct_count: String(session.status) === "submitted" ? Number(session.correctCount || 0) : null,
    incorrect_count: String(session.status) === "submitted" ? Number(session.incorrectCount || 0) : null,
    unanswered_count: String(session.status) === "submitted" ? Number(session.unansweredCount || 0) : null,
    score_percent: String(session.status) === "submitted" ? Number(session.scorePercent || 0) : null,
    duration_ms: session.durationMs ?? null,
    started_at: session.startedAt || session.createdAt || null,
    submitted_at: session.submittedAt || null,
    updated_at: session.updatedAt || null,
  };
}

export function qbankSessionHistoryRow(session = {}) {
  const safe = sanitizeAylaQbankSession(session);
  return {
    id: safe.id,
    exam_track: safe.exam_track,
    mode: safe.mode,
    purpose: safe.purpose,
    origin: safe.origin,
    status: safe.status,
    filters: safe.filters,
    question_count: safe.question_count,
    answered_count: safe.answered_count,
    correct_count: safe.correct_count,
    incorrect_count: safe.incorrect_count,
    unanswered_count: safe.unanswered_count,
    score_percent: safe.score_percent,
    started_at: safe.started_at,
    submitted_at: safe.submitted_at,
    duration_ms: safe.duration_ms,
  };
}
