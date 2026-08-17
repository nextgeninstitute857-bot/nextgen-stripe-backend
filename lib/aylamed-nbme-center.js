export const AYLA_NBME_CENTER_BUILD = "v256-exam-scoped-readiness-center";
export const AYLA_NBME_CONTENT_DESTINATION = "aylamed_nbme";
export const AYLA_NBME_SCORING_VERSION = "aylamed_nbme_raw_accuracy_v1";
export const AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS = Object.freeze([
  "nbme-step-1-form-25",
  "nbme-step-1-form-26",
  "nbme-step-1-form-28",
  "nbme-step-1-form-30",
  "nbme-step-1-form-31",
  "nbme-step-1-form-32",
]);

const TERMINAL_ATTEMPT_STATES = new Set(["submitted", "cancelled", "expired"]);
const SUPPORTED_EXAMS = new Set(["usmle-step-1", "usmle-step-2", "usmle-step-3"]);

const CMS_SPECIALTIES = Object.freeze({
  "emergency-med": { key: "emergency_medicine", label: "Emergency Medicine" },
  "emergency-medicine": { key: "emergency_medicine", label: "Emergency Medicine" },
  "family-med": { key: "family_medicine", label: "Family Medicine" },
  "family-medicine": { key: "family_medicine", label: "Family Medicine" },
  medicine: { key: "internal_medicine", label: "Internal Medicine" },
  neurology: { key: "neurology", label: "Neurology" },
  "ob-gyn": { key: "obstetrics_gynecology", label: "Obstetrics and Gynecology" },
  pediatrics: { key: "pediatrics", label: "Pediatrics" },
  psychiatry: { key: "psychiatry", label: "Psychiatry" },
  surgery: { key: "surgery", label: "Surgery" },
});

function nbmeError(message, statusCode = 400, code = "NBME_CENTER_INVALID_REQUEST") {
  return Object.assign(new Error(message), { statusCode, code });
}

function cleanString(value = "", maximum = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

function cleanInteger(value, fallback = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

export function normalizeAylaNbmeExamTrack(value = "") {
  const clean = cleanString(value, 120).toLowerCase().replace(/[\s_]+/g, "-");
  const aliases = {
    "step-1": "usmle-step-1",
    step1: "usmle-step-1",
    "usmle-step1": "usmle-step-1",
    "usmle-step-1": "usmle-step-1",
    "step-2": "usmle-step-2",
    "step-2-ck": "usmle-step-2",
    step2: "usmle-step-2",
    step2ck: "usmle-step-2",
    "usmle-step2": "usmle-step-2",
    "usmle-step-2": "usmle-step-2",
    "usmle-step-2-ck": "usmle-step-2",
    "step-3": "usmle-step-3",
    step3: "usmle-step-3",
    "usmle-step3": "usmle-step-3",
    "usmle-step-3": "usmle-step-3",
  };
  const normalized = aliases[clean] || clean;
  return SUPPORTED_EXAMS.has(normalized) ? normalized : null;
}

export function aylaNbmeShellExamTrack(value = "") {
  const examTrack = normalizeAylaNbmeExamTrack(value);
  return examTrack ? examTrack.replace(/-/g, "_").replace("_step_2", "_step_2_ck") : null;
}

function normalizeCollectionKey(value = "") {
  return cleanString(value, 180)
    .toLowerCase()
    .replace(/\.db$/i, "")
    .replace(/_questions(?:\.json)?$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseAylaNbmeCollectionKey(value = "") {
  const collectionKey = normalizeCollectionKey(value);
  let match = collectionKey.match(/^nbme-1-(\d{1,3})$/);
  if (match) {
    const formNumber = Number(match[1]);
    return {
      collectionKey,
      formId: `nbme-step-1-form-${formNumber}`,
      examTrack: "usmle-step-1",
      shellExamTrack: "usmle_step_1",
      formType: "comprehensive_self_assessment",
      family: "cbssa",
      formNumber,
      specialtyKey: null,
      specialtyLabel: null,
      title: `Step 1 Self-Assessment Form ${formNumber}`,
      shortTitle: `Form ${formNumber}`,
      expectedQuestionCount: 200,
      blockSize: 50,
      expectedBlockCount: 4,
    };
  }
  match = collectionKey.match(/^nbme-2-(\d{1,3})$/);
  if (match) {
    const formNumber = Number(match[1]);
    return {
      collectionKey,
      formId: `nbme-step-2-ck-form-${formNumber}`,
      examTrack: "usmle-step-2",
      shellExamTrack: "usmle_step_2_ck",
      formType: "comprehensive_self_assessment",
      family: "ccssa",
      formNumber,
      specialtyKey: null,
      specialtyLabel: null,
      title: `Step 2 CK Self-Assessment Form ${formNumber}`,
      shortTitle: `Form ${formNumber}`,
      expectedQuestionCount: 200,
      blockSize: 50,
      expectedBlockCount: 4,
    };
  }
  match = collectionKey.match(/^nbme-3-(\d{1,3})$/);
  if (match) {
    const formNumber = Number(match[1]);
    return {
      collectionKey,
      formId: `nbme-step-3-form-${formNumber}`,
      examTrack: "usmle-step-3",
      shellExamTrack: "usmle_step_3",
      formType: "comprehensive_self_assessment",
      family: "step_3_self_assessment",
      formNumber,
      specialtyKey: null,
      specialtyLabel: null,
      title: `Step 3 Self-Assessment Form ${formNumber}`,
      shortTitle: `Form ${formNumber}`,
      expectedQuestionCount: 200,
      blockSize: 50,
      expectedBlockCount: 4,
    };
  }
  match = collectionKey.match(/^nbme-(emergency-med(?:icine)?|family-med(?:icine)?|medicine|neurology|ob-gyn|pediatrics|psychiatry|surgery)-(\d{1,3})$/);
  if (match) {
    const specialty = CMS_SPECIALTIES[match[1]];
    const formNumber = Number(match[2]);
    return {
      collectionKey,
      formId: `nbme-step-2-ck-${specialty.key}-form-${formNumber}`,
      examTrack: "usmle-step-2",
      shellExamTrack: "usmle_step_2_ck",
      formType: "clinical_subject",
      family: "cms",
      formNumber,
      specialtyKey: specialty.key,
      specialtyLabel: specialty.label,
      title: `${specialty.label} Subject Form ${formNumber}`,
      shortTitle: `${specialty.label} ${formNumber}`,
      expectedQuestionCount: 50,
      blockSize: 50,
      expectedBlockCount: 1,
    };
  }
  return null;
}

export function assertAylaNbmeReviewedReleaseForm(formId = "", collectionKey = "") {
  const cleanFormId = cleanString(formId, 180);
  const definition = parseAylaNbmeCollectionKey(collectionKey);
  if (!definition || definition.formId !== cleanFormId) {
    throw nbmeError(
      "The requested form does not match its reviewed collection",
      409,
      "NBME_RELEASE_FORM_COLLECTION_MISMATCH",
    );
  }
  if (definition.examTrack === "usmle-step-1"
    && !AYLA_NBME_STEP1_REVIEWED_RELEASE_FORM_IDS.includes(cleanFormId)) {
    throw nbmeError(
      "Only the six reviewed complete Step 1 forms can use this release control",
      403,
      "NBME_RELEASE_FORM_NOT_REVIEWED",
    );
  }
  return definition;
}

export function assertAylaNbmeExamPlacement(form = {}, requestedExamTrack = "") {
  const requested = normalizeAylaNbmeExamTrack(requestedExamTrack);
  const formExam = normalizeAylaNbmeExamTrack(
    form.examTrack || form.exam_track || form.examTrackId || form.exam_track_id,
  );
  if (!requested || !formExam || requested !== formExam) {
    throw nbmeError(
      "This self-assessment belongs to a different exam dashboard",
      403,
      "NBME_FORM_EXAM_MISMATCH",
    );
  }
  return requested;
}

function qualityGateForForm(input = {}, definition = parseAylaNbmeCollectionKey(input.collectionKey || input.collection_key)) {
  const expected = cleanInteger(
    input.expectedQuestionCount ?? input.expected_question_count,
    definition?.expectedQuestionCount || 0,
    0,
    1_000,
  );
  const sourceCount = cleanInteger(
    input.sourceQuestionCount ?? input.source_question_count ?? input.questionCount ?? input.question_count,
    0,
    0,
    1_000,
  );
  const importedCount = cleanInteger(
    input.importedQuestionCount ?? input.imported_question_count,
    sourceCount,
    0,
    1_000,
  );
  const missingExplanations = cleanInteger(
    input.missingExplanations ?? input.missing_explanations,
    0,
    0,
    1_000,
  );
  const orphanAnswers = cleanInteger(input.orphanAnswers ?? input.orphan_answers, 0, 0, 1_000);
  const missingMedia = cleanInteger(input.missingMedia ?? input.missing_media, 0, 0, 10_000);
  const ambiguousMedia = cleanInteger(input.ambiguousMedia ?? input.ambiguous_media, 0, 0, 10_000);
  const corruptMedia = cleanInteger(input.corruptMedia ?? input.corrupt_media, 0, 0, 10_000);
  const invalidAnswerKeys = cleanInteger(input.invalidAnswerKeys ?? input.invalid_answer_keys, 0, 0, 1_000);
  const reasons = [];
  if (!definition) reasons.push("unrecognized_form");
  if (!expected || sourceCount !== expected) reasons.push("unexpected_question_count");
  if (importedCount !== expected) reasons.push("incomplete_import");
  if (missingExplanations) reasons.push("missing_explanations");
  if (orphanAnswers) reasons.push("orphan_answers");
  if (invalidAnswerKeys) reasons.push("invalid_answer_keys");
  if (missingMedia) reasons.push("missing_media");
  if (ambiguousMedia) reasons.push("ambiguous_media");
  if (corruptMedia) reasons.push("corrupt_media");
  return {
    ready: reasons.length === 0,
    reasons,
    expected_question_count: expected,
    source_question_count: sourceCount,
    imported_question_count: importedCount,
    missing_explanations: missingExplanations,
    orphan_answers: orphanAnswers,
    invalid_answer_keys: invalidAnswerKeys,
    missing_media: missingMedia,
    ambiguous_media: ambiguousMedia,
    corrupt_media: corruptMedia,
  };
}

export function normalizeAylaNbmeManifest(input = {}) {
  const rows = Array.isArray(input) ? input : values(input.forms);
  if (!rows.length || rows.length > 100) {
    throw nbmeError("A self-assessment manifest must contain between 1 and 100 forms");
  }
  const forms = [];
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    const definition = parseAylaNbmeCollectionKey(
      row?.collectionKey || row?.collection_key || row?.folder || row?.form_key,
    );
    if (!definition) {
      throw nbmeError(
        `Manifest form ${index + 1} has an unsupported collection key`,
        400,
        "NBME_MANIFEST_FORM_UNSUPPORTED",
      );
    }
    const declaredExam = row?.examTrack || row?.exam_track || row?.examTrackId || row?.exam_track_id;
    if (declaredExam && normalizeAylaNbmeExamTrack(declaredExam) !== definition.examTrack) {
      throw nbmeError(
        `${definition.collectionKey} is mapped to the wrong exam`,
        409,
        "NBME_MANIFEST_EXAM_MISMATCH",
      );
    }
    if (ids.has(definition.formId)) {
      throw nbmeError(`Duplicate self-assessment form ${definition.collectionKey}`, 409, "NBME_MANIFEST_DUPLICATE_FORM");
    }
    ids.add(definition.formId);
    const qualityGate = qualityGateForForm(row, definition);
    forms.push({
      ...definition,
      sourceQuestionCount: qualityGate.source_question_count,
      importedQuestionCount: qualityGate.imported_question_count,
      answerChoiceCount: cleanInteger(row.answerChoiceCount ?? row.answer_choice_count, 0, 0, 20_000),
      mediaCount: cleanInteger(row.mediaCount ?? row.media_count, 0, 0, 10_000),
      missingExplanationCount: qualityGate.missing_explanations,
      orphanAnswerCount: qualityGate.orphan_answers,
      invalidAnswerKeyCount: qualityGate.invalid_answer_keys,
      sourceSha256: cleanString(row.sourceSha256 || row.source_sha256, 64).toLowerCase(),
      contentImportJobId: cleanString(row.contentImportJobId || row.content_import_job_id, 120) || null,
      collectionId: cleanString(row.collectionId || row.collection_id, 120) || null,
      qualityGate,
    });
  }
  return {
    version: cleanInteger(input.version, 1, 1, 100),
    archiveSha256: cleanString(input.archiveSha256 || input.archive_sha256, 64).toLowerCase() || null,
    forms,
  };
}

export function buildAylaNbmeFormRecord(input = {}, previous = {}, now = new Date()) {
  const definition = parseAylaNbmeCollectionKey(
    input.collectionKey || input.collection_key || previous.collectionKey || previous.collection_key,
  );
  if (!definition) throw nbmeError("A recognized self-assessment collection key is required");
  const qualityGate = qualityGateForForm({ ...previous, ...input }, definition);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    id: definition.formId,
    ...definition,
    sourceQuestionCount: qualityGate.source_question_count,
    importedQuestionCount: qualityGate.imported_question_count,
    answerChoiceCount: cleanInteger(
      input.answerChoiceCount ?? input.answer_choice_count ?? previous.answerChoiceCount,
      0,
      0,
      20_000,
    ),
    mediaCount: cleanInteger(input.mediaCount ?? input.media_count ?? previous.mediaCount, 0, 0, 10_000),
    missingExplanationCount: qualityGate.missing_explanations,
    orphanAnswerCount: qualityGate.orphan_answers,
    invalidAnswerKeyCount: qualityGate.invalid_answer_keys,
    sourceSha256: cleanString(input.sourceSha256 || input.source_sha256 || previous.sourceSha256, 64).toLowerCase() || null,
    archiveSha256: cleanString(input.archiveSha256 || input.archive_sha256 || previous.archiveSha256, 64).toLowerCase() || null,
    contentImportJobId: cleanString(
      input.contentImportJobId || input.content_import_job_id || previous.contentImportJobId,
      120,
    ) || null,
    collectionId: cleanString(input.collectionId || input.collection_id || previous.collectionId, 120) || null,
    registryStatus: cleanString(input.registryStatus || input.registry_status || previous.registryStatus || "not_imported", 60),
    rightsStatus: cleanString(input.rightsStatus || input.rights_status || previous.rightsStatus || "unverified", 60),
    destinationEnabled: input.destinationEnabled === true || input.destination_enabled === true,
    qualityGate,
    status: input.studentEnabled === true || input.student_enabled === true
      ? "student_enabled"
      : qualityGate.ready
        ? "review_ready"
        : "private_draft",
    studentEnabled: input.studentEnabled === true || input.student_enabled === true,
    createdAt: previous.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

export function validateAylaNbmeStudentEnable(form = {}, {
  confirmQualityOverride = false,
  qualityOverrideReason = "",
} = {}) {
  const qualityGate = qualityGateForForm(form);
  const registryReady = String(form.registryStatus || "").toLowerCase() === "approved";
  const rightsReady = ["owned", "licensed", "authorized"].includes(String(form.rightsStatus || "").toLowerCase());
  const destinationReady = form.destinationEnabled === true;
  const reasons = [
    ...qualityGate.reasons,
    ...(!form.collectionId ? ["content_collection_missing"] : []),
    ...(!registryReady ? ["content_collection_not_approved"] : []),
    ...(!rightsReady ? ["content_rights_unverified"] : []),
    ...(!destinationReady ? ["student_destination_disabled"] : []),
  ];
  if (!reasons.length) return { allowed: true, override: false, reasons: [] };
  const reason = cleanString(qualityOverrideReason, 1_000);
  if (confirmQualityOverride === true && reason && registryReady && rightsReady && destinationReady && form.collectionId) {
    return { allowed: true, override: true, reasons, reason };
  }
  throw nbmeError(
    `This form cannot be enabled for students: ${reasons.join(", ")}`,
    409,
    "NBME_FORM_QUALITY_GATE_FAILED",
  );
}

function questionPosition(question = {}, index = 0) {
  const raw = question.source_position
    ?? question.sourcePosition
    ?? question.source_data?.source_position
    ?? question.sourceData?.source_position;
  return cleanInteger(raw, index + 1, 1, 10_000);
}

function questionFingerprint(question = {}) {
  return cleanString(
    question.canonical_hash || question.canonicalHash || question.content_hash || question.contentHash,
    128,
  ) || null;
}

export function createAylaNbmeAttempt({
  id,
  userId,
  studentId,
  examTrack,
  form,
  questions = [],
  entitlement = null,
  previousAttempts = [],
  idempotencyKey = "",
  idempotencyFingerprint = "",
  now = new Date(),
} = {}) {
  const definition = parseAylaNbmeCollectionKey(form?.collectionKey || form?.collection_key);
  if (!definition) throw nbmeError("A recognized self-assessment form is required");
  const normalizedExam = assertAylaNbmeExamPlacement(definition, examTrack);
  if (form?.studentEnabled !== true && form?.student_enabled !== true) {
    throw nbmeError("This self-assessment is not enabled for students", 409, "NBME_FORM_NOT_ENABLED");
  }
  const mappings = values(questions).map((question, index) => ({
    ref: cleanString(question.question_ref || question.questionRef, 120),
    contentQuestionId: cleanString(question.id || question.content_question_id || question.contentQuestionId, 120),
    canonicalHash: questionFingerprint(question),
    sourcePosition: questionPosition(question, index),
  })).filter((row) => row.ref && row.contentQuestionId)
    .sort((left, right) => left.sourcePosition - right.sourcePosition || left.contentQuestionId.localeCompare(right.contentQuestionId));
  if (!mappings.length) throw nbmeError("This form has no approved questions", 409, "NBME_FORM_EMPTY");
  if (new Set(mappings.map((row) => row.ref)).size !== mappings.length
    || new Set(mappings.map((row) => row.contentQuestionId)).size !== mappings.length) {
    throw nbmeError("This form contains duplicate question identities", 409, "NBME_FORM_DUPLICATE_QUESTION");
  }
  const priorFingerprints = new Set(values(previousAttempts)
    .filter((attempt) => String(attempt.status || "") === "submitted" && attempt.serverVerified === true)
    .flatMap((attempt) => values(attempt.questionFingerprints || attempt.question_fingerprints))
    .map(String)
    .filter(Boolean));
  const repeatedItemCount = mappings.filter((row) => row.canonicalHash && priorFingerprints.has(row.canonicalHash)).length;
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const blockSize = definition.blockSize;
  const blocks = [];
  for (let index = 0; index < mappings.length; index += blockSize) {
    blocks.push({
      index: blocks.length,
      questionRefs: mappings.slice(index, index + blockSize).map((row) => row.ref),
    });
  }
  return {
    id: cleanString(id, 120),
    userId: cleanString(userId, 120),
    studentId: cleanString(studentId, 120),
    examTrack: normalizedExam,
    formId: definition.formId,
    collectionId: cleanString(form.collectionId || form.collection_id, 120),
    collectionKey: definition.collectionKey,
    formType: definition.formType,
    family: definition.family,
    title: definition.title,
    status: "in_progress",
    version: 1,
    questions: mappings,
    questionFingerprints: mappings.map((row) => row.canonicalHash).filter(Boolean),
    questionCount: mappings.length,
    expectedQuestionCount: definition.expectedQuestionCount,
    blockSize,
    blocks,
    answers: {},
    answeredCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    unansweredCount: mappings.length,
    scorePercent: null,
    currentQuestionIndex: 0,
    repeatedItemCount,
    repeatedItemPercent: mappings.length ? Math.round((repeatedItemCount / mappings.length) * 10_000) / 100 : 0,
    contentComplete: mappings.length === definition.expectedQuestionCount,
    entitlementSnapshot: entitlement ? {
      type: entitlement.entitlement_type || null,
      enrollmentId: entitlement.enrollment_id || null,
      planId: entitlement.plan_id || null,
    } : null,
    idempotencyKey: cleanString(idempotencyKey, 120) || null,
    idempotencyFingerprint: cleanString(idempotencyFingerprint, 128) || null,
    serverVerified: false,
    scoringVersion: null,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    submittedAt: null,
  };
}

export function aylaNbmeAttemptQuestion(attempt = {}, questionRef = "") {
  const ref = cleanString(questionRef, 120);
  return values(attempt.questions).find((row) => String(row.ref) === ref) || null;
}

export function recordAylaNbmeAnswer(attempt = {}, {
  questionRef,
  selectedAnswerId,
  correctAnswerId,
  elapsedMs = null,
  currentQuestionIndex = null,
  expectedVersion = null,
  now = new Date(),
} = {}) {
  if (TERMINAL_ATTEMPT_STATES.has(String(attempt.status || "").toLowerCase())) {
    throw nbmeError("This self-assessment attempt is already closed", 409, "NBME_ATTEMPT_CLOSED");
  }
  if (expectedVersion !== null && expectedVersion !== undefined
    && cleanInteger(expectedVersion, -1, -1) !== cleanInteger(attempt.version, 0)) {
    throw nbmeError(
      "This attempt changed on another tab. Refresh before saving this answer.",
      409,
      "NBME_ATTEMPT_VERSION_CONFLICT",
    );
  }
  const mapping = aylaNbmeAttemptQuestion(attempt, questionRef);
  if (!mapping) throw nbmeError("Question does not belong to this self-assessment", 404, "NBME_QUESTION_NOT_FOUND");
  const selected = Number(selectedAnswerId);
  const correct = Number(correctAnswerId);
  if (!Number.isInteger(selected) || !Number.isInteger(correct)) {
    throw nbmeError("A valid answer choice is required");
  }
  const existing = attempt.answers?.[mapping.ref] || null;
  if (existing && Number(existing.selectedAnswerId) === selected) {
    return { attempt, answer: existing, replayed: true };
  }
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const answer = {
    questionRef: mapping.ref,
    contentQuestionId: mapping.contentQuestionId,
    selectedAnswerId: selected,
    correctAnswerId: correct,
    correct: selected === correct,
    elapsedMs: Number.isFinite(Number(elapsedMs))
      ? Math.max(0, Math.min(24 * 60 * 60 * 1_000, Math.round(Number(elapsedMs))))
      : null,
    answeredAt: timestamp,
  };
  const answers = { ...(attempt.answers || {}), [mapping.ref]: answer };
  const answerRows = Object.values(answers);
  const nextIndex = currentQuestionIndex === null || currentQuestionIndex === undefined
    ? attempt.currentQuestionIndex
    : cleanInteger(currentQuestionIndex, attempt.currentQuestionIndex || 0, 0, Math.max(0, attempt.questionCount - 1));
  return {
    answer,
    replayed: false,
    attempt: {
      ...attempt,
      answers,
      answeredCount: answerRows.length,
      correctCount: answerRows.filter((row) => row.correct === true).length,
      incorrectCount: answerRows.filter((row) => row.correct === false).length,
      unansweredCount: Math.max(0, Number(attempt.questionCount || 0) - answerRows.length),
      currentQuestionIndex: nextIndex,
      version: cleanInteger(attempt.version, 0) + 1,
      updatedAt: timestamp,
    },
  };
}

export function finalizeAylaNbmeAttempt(attempt = {}, {
  confirmPartial = false,
  expectedVersion = null,
  now = new Date(),
} = {}) {
  if (String(attempt.status || "") === "submitted") return { attempt, replayed: true };
  if (TERMINAL_ATTEMPT_STATES.has(String(attempt.status || "").toLowerCase())) {
    throw nbmeError("This self-assessment attempt is already closed", 409, "NBME_ATTEMPT_CLOSED");
  }
  if (expectedVersion !== null && expectedVersion !== undefined
    && cleanInteger(expectedVersion, -1, -1) !== cleanInteger(attempt.version, 0)) {
    throw nbmeError(
      "This attempt changed on another tab. Refresh before submitting it.",
      409,
      "NBME_ATTEMPT_VERSION_CONFLICT",
    );
  }
  const total = cleanInteger(attempt.questionCount, values(attempt.questions).length, 1, 1_000);
  const answers = Object.values(attempt.answers || {});
  const unansweredCount = Math.max(0, total - answers.length);
  if (unansweredCount && confirmPartial !== true) {
    throw nbmeError(
      `${unansweredCount} question${unansweredCount === 1 ? " is" : "s are"} unanswered`,
      409,
      "NBME_ATTEMPT_PARTIAL_CONFIRMATION_REQUIRED",
    );
  }
  const correctCount = answers.filter((row) => row.correct === true).length;
  const scorePercent = Math.round((correctCount / total) * 10_000) / 100;
  const submittedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const repeatedPercent = Number(attempt.repeatedItemPercent || 0);
  const readinessConfidence = !attempt.contentComplete
    ? "limited_incomplete_form"
    : repeatedPercent >= 10
      ? "limited_repeated_exposure"
      : unansweredCount
        ? "limited_partial_attempt"
        : "standard";
  return {
    replayed: false,
    attempt: {
      ...attempt,
      status: "submitted",
      answeredCount: answers.length,
      correctCount,
      incorrectCount: Math.max(0, answers.length - correctCount),
      unansweredCount,
      scorePercent,
      serverVerified: true,
      scoringVersion: AYLA_NBME_SCORING_VERSION,
      readinessSignal: {
        raw_accuracy_percent: scorePercent,
        completion_percent: Math.round((answers.length / total) * 10_000) / 100,
        confidence: readinessConfidence,
        official_predicted_score: null,
        pass_guarantee: false,
        note: "This is an internal practice signal, not an official predicted score or pass guarantee.",
      },
      version: cleanInteger(attempt.version, 0) + 1,
      submittedAt,
      updatedAt: submittedAt,
    },
  };
}

export function sanitizeAylaNbmeAttempt(attempt = {}) {
  const {
    questionFingerprints: _questionFingerprints,
    idempotencyFingerprint: _idempotencyFingerprint,
    idempotencyKey: _idempotencyKey,
    entitlementSnapshot: _entitlementSnapshot,
    collectionId: _collectionId,
    userId: _userId,
    studentId: _studentId,
    correctCount,
    incorrectCount,
    scorePercent,
    readinessSignal,
    scoringVersion,
    serverVerified,
    answers: rawAnswers,
    ...safe
  } = attempt;
  const submitted = String(attempt.status || "") === "submitted";
  const answers = Object.fromEntries(Object.entries(rawAnswers || {}).map(([key, row]) => [
    key,
    {
      questionRef: row.questionRef,
      selectedAnswerId: Number(row.selectedAnswerId),
      ...(submitted ? {
        correctAnswerId: Number(row.correctAnswerId),
        correct: row.correct === true,
      } : {}),
      elapsedMs: row.elapsedMs ?? null,
      answeredAt: row.answeredAt || null,
    },
  ]));
  return {
    ...safe,
    serverVerified: submitted && serverVerified === true,
    ...(submitted ? {
      correctCount: Number(correctCount || 0),
      incorrectCount: Number(incorrectCount || 0),
      scorePercent: Number(scorePercent || 0),
      readinessSignal: readinessSignal || null,
      scoringVersion: scoringVersion || null,
    } : {}),
    questions: values(attempt.questions).map((row) => ({
      ref: row.ref,
      sourcePosition: row.sourcePosition,
    })),
    answers,
  };
}

export function aylaNbmeHistoryRow(attempt = {}) {
  return {
    id: attempt.id,
    form_id: attempt.formId,
    collection_key: attempt.collectionKey,
    title: attempt.title,
    form_type: attempt.formType,
    exam_track: attempt.examTrack,
    status: attempt.status,
    question_count: Number(attempt.questionCount || 0),
    answered_count: Number(attempt.answeredCount || 0),
    score_percent: attempt.status === "submitted" ? Number(attempt.scorePercent || 0) : null,
    repeated_item_percent: Number(attempt.repeatedItemPercent || 0),
    readiness_signal: attempt.status === "submitted" ? attempt.readinessSignal || null : null,
    started_at: attempt.startedAt || attempt.createdAt || null,
    updated_at: attempt.updatedAt || null,
    submitted_at: attempt.submittedAt || null,
  };
}

function dateOnly(value) {
  const match = cleanString(value, 80).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || null;
}

function dayDifference(fromValue, toValue) {
  const from = dateOnly(fromValue);
  const to = dateOnly(toValue);
  if (!from || !to) return null;
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function addDays(value, days) {
  const date = new Date(`${dateOnly(value) || new Date().toISOString().slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function targetDateForStudent(student = {}) {
  return dateOnly(
    student.targetDate
      || student.target_date
      || student.examDate
      || student.exam_date
      || student.matchDate
      || student.match_date,
  );
}

export function buildAylaNbmeReadinessSnapshot({
  student = {},
  attempts = [],
  forms = [],
  warning = {},
  date = new Date().toISOString().slice(0, 10),
} = {}) {
  const examTrack = normalizeAylaNbmeExamTrack(
    student.examTrackId || student.exam_track_id || student.examTrack || student.exam_track || student.exam,
  );
  if (!examTrack) {
    return {
      exam_track: null,
      supported: false,
      completed_full_forms: 0,
      available_full_forms: 0,
      unused_full_forms: 0,
      latest: null,
      trend_points: null,
      days_since_latest: null,
      target_date: targetDateForStudent(student),
      days_to_target: null,
      recommendation: null,
      authority: {
        server_verified_attempts_only: true,
        official_predicted_score: false,
        pass_guarantee: false,
        one_stored_roadmap: true,
      },
    };
  }
  const submitted = values(attempts)
    .filter((row) => row.serverVerified === true && String(row.status || "") === "submitted")
    .filter((row) => normalizeAylaNbmeExamTrack(row.examTrack || row.exam_track || row.examTrackId) === examTrack)
    .filter((row) => String(row.formType || row.form_type) === "comprehensive_self_assessment")
    .sort((left, right) => String(right.submittedAt || right.updatedAt || "").localeCompare(String(left.submittedAt || left.updatedAt || "")));
  const inProgress = values(attempts)
    .filter((row) => String(row.status || "") === "in_progress")
    .filter((row) => normalizeAylaNbmeExamTrack(row.examTrack || row.exam_track || row.examTrackId) === examTrack)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0] || null;
  const available = values(forms)
    .filter((row) => row.studentEnabled === true || row.student_enabled === true)
    .filter((row) => normalizeAylaNbmeExamTrack(row.examTrack || row.exam_track) === examTrack);
  const fullForms = available.filter((row) => String(row.formType || row.form_type) === "comprehensive_self_assessment");
  const usedFormIds = new Set(submitted.map((row) => String(row.formId || row.form_id)));
  const unusedFullForms = fullForms.filter((row) => !usedFormIds.has(String(row.id || row.formId || row.form_id)));
  const latest = submitted[0] || null;
  const previous = submitted[1] || null;
  const latestScore = latest ? Number(latest.scorePercent ?? latest.score_percent) : null;
  const previousScore = previous ? Number(previous.scorePercent ?? previous.score_percent) : null;
  const trend = Number.isFinite(latestScore) && Number.isFinite(previousScore)
    ? Math.round((latestScore - previousScore) * 100) / 100
    : null;
  const targetDate = targetDateForStudent(student);
  const daysToTarget = targetDate ? dayDifference(date, targetDate) : null;
  const daysSinceLatest = latest ? dayDifference(latest.submittedAt || latest.updatedAt, date) : null;
  const overloaded = ["high", "critical"].includes(String(warning.level || "").toLowerCase())
    || Number(warning.backlogMinutes || warning.backlog_minutes || 0) > Math.max(180, Number(warning.dailyCapacityMinutes || 0));
  let recommendation;
  if (inProgress) {
    recommendation = {
      state: "resume_in_progress",
      title: `Resume ${inProgress.title || "your self-assessment"}`,
      reason: "Your answers are saved. Finish the existing attempt before starting another readiness form.",
      suggested_date: date,
      form_id: inProgress.formId || inProgress.form_id || null,
      attempt_id: inProgress.id || null,
      route: `/dashboard/nbme?attempt=${encodeURIComponent(String(inProgress.id || ""))}`,
    };
  } else if (!fullForms.length) {
    recommendation = {
      state: "no_full_form_available",
      title: "No full self-assessment is available yet",
      reason: "AylaMed will keep monitoring verified study progress until a complete form is reviewed and enabled for this exam.",
      suggested_date: null,
      form_id: null,
      attempt_id: null,
      route: "/dashboard/nbme",
    };
  } else if (overloaded) {
    recommendation = {
      state: "recover_workload_first",
      title: "Stabilize your workload before a full self-assessment",
      reason: "A full readiness form is most useful when you have protected time to complete and review it. Clear the urgent backlog first.",
      suggested_date: addDays(date, 3),
      form_id: (unusedFullForms[0] || fullForms[0])?.id || null,
      attempt_id: null,
      route: "/dashboard/nbme",
    };
  } else if (!latest) {
    const waitDays = Number.isFinite(daysToTarget) && daysToTarget <= 21 ? 2 : 7;
    recommendation = {
      state: "baseline_due",
      title: "Take your first full self-assessment",
      reason: Number.isFinite(daysToTarget)
        ? `A server-verified full-form result will add readiness-trend evidence to the same roadmap for the remaining ${Math.max(0, daysToTarget)} days.`
        : "A server-verified full-form result will add readiness-trend evidence to the same roadmap.",
      suggested_date: addDays(date, waitDays),
      form_id: (unusedFullForms[0] || fullForms[0])?.id || null,
      attempt_id: null,
      route: "/dashboard/nbme",
    };
  } else if (daysSinceLatest !== null && daysSinceLatest < 7) {
    recommendation = {
      state: "review_before_next_form",
      title: "Review this result before taking another full form",
      reason: `Your latest verified result is ${latestScore}% raw practice accuracy. Use the current roadmap to repair weak areas before another full-form check.`,
      suggested_date: addDays(latest.submittedAt || latest.updatedAt, 7),
      form_id: (unusedFullForms[0] || fullForms[0])?.id || null,
      attempt_id: null,
      route: "/dashboard/nbme",
    };
  } else {
    const waitDays = Number.isFinite(daysToTarget) && daysToTarget <= 14 ? 2 : 7;
    recommendation = {
      state: "next_form_due",
      title: "A new readiness check is due",
      reason: trend === null
        ? "Enough time has passed since the last full form to measure change after focused review."
        : `Your verified raw-accuracy trend is ${trend >= 0 ? "+" : ""}${trend} points. A fresh unused form can confirm whether that change holds.`,
      suggested_date: addDays(date, waitDays),
      form_id: (unusedFullForms[0] || fullForms[0])?.id || null,
      attempt_id: null,
      route: "/dashboard/nbme",
    };
  }
  return {
    exam_track: examTrack,
    supported: true,
    completed_full_forms: submitted.length,
    available_full_forms: fullForms.length,
    unused_full_forms: unusedFullForms.length,
    latest: latest ? aylaNbmeHistoryRow(latest) : null,
    trend_points: trend,
    days_since_latest: daysSinceLatest,
    target_date: targetDate,
    days_to_target: daysToTarget,
    recommendation,
    authority: {
      server_verified_attempts_only: true,
      official_predicted_score: false,
      pass_guarantee: false,
      one_stored_roadmap: true,
    },
  };
}
