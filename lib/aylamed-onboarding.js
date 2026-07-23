const ONBOARDING_PATHS = new Set([
  "diagnostic_test",
  "quick_profile",
  "starting_fresh",
  "legacy_profile",
]);

const STUDY_STAGES = new Set([
  "not_started",
  "some_systems",
  "first_pass_in_progress",
  "first_pass_complete",
  "revision",
  "qbank_focused",
  "diagnostic_pending",
  "diagnostic_complete",
  "not_specified",
]);

const QBANK_COMPLETION_PRESETS = new Set([0, 25, 50, 75, 100]);
const QBANK_AVERAGE_PRESETS = new Set([0, 35, 45, 55, 65, 75]);

const SYSTEM_ALIASES = Object.freeze({
  cardiology: "cardiovascular",
  "cardiovascular system": "cardiovascular",
  pulmonology: "respiratory",
  pulmonary: "respiratory",
  git: "gastrointestinal",
  gastroenterology: "gastrointestinal",
  endocrine: "endocrinology",
  msk: "musculoskeletal",
  "behavioral sciences": "behavioral science",
  "ethics biostatistics": "biostatistics and ethics",
  "biostatistics ethics": "biostatistics and ethics",
  obgyn: "obstetrics and gynecology",
  "ob gyn": "obstetrics and gynecology",
  paediatrics: "pediatrics",
  "womens health": "women s health",
});

function onboardingError(message, code = "INVALID_ONBOARDING_REQUEST") {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function cleanText(value = "", max = 180) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, max);
}

function cleanList(value = [], max = 20) {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(rows.map((item) => cleanText(item)).filter(Boolean))].slice(0, max);
}

function systemKey(value = "") {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return SYSTEM_ALIASES[normalized] || normalized;
}

function percent(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw onboardingError("Percentages must be between 0 and 100", "INVALID_ONBOARDING_PERCENTAGE");
  }
  return Math.round(parsed);
}

function presetPercent(value, presets, field) {
  const parsed = percent(value, 0);
  if (!presets.has(parsed)) {
    throw onboardingError(`${field} must use one of the supported quick-select values`, "INVALID_ONBOARDING_PRESET");
  }
  return parsed;
}

function matchingExamSystems(requested = [], examDefinition = {}) {
  const systems = cleanList(examDefinition.systems || [], 100);
  const byKey = new Map(systems.map((system) => [systemKey(system), system]));
  const matched = [];
  const unknown = [];
  for (const input of cleanList(requested, 12)) {
    const canonical = byKey.get(systemKey(input));
    if (!canonical) unknown.push(input);
    else if (!matched.includes(canonical)) matched.push(canonical);
  }
  if (unknown.length) {
    throw onboardingError(
      `These weak areas do not belong to ${examDefinition.label || "the selected exam"}: ${unknown.join(", ")}`,
      "ONBOARDING_SYSTEM_EXAM_MISMATCH",
    );
  }
  return matched.slice(0, 6);
}

export function normalizeAylaOnboardingPath(value = "") {
  const key = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) return "legacy_profile";
  if (["diagnostic", "diagnostic_test", "take_diagnostic", "take_the_diagnostic", "test"].includes(key)) return "diagnostic_test";
  if (["quick", "quick_profile", "quick_self_assessment", "self_assessment", "self_report", "manual"].includes(key)) return "quick_profile";
  if (["starting_fresh", "fresh", "new_student", "just_starting", "not_started"].includes(key)) return "starting_fresh";
  if (["legacy", "legacy_profile"].includes(key)) return "legacy_profile";
  throw onboardingError("Choose diagnostic test, quick self-assessment, or starting fresh", "INVALID_ONBOARDING_PATH");
}

export function normalizeAylaStudyStage(value = "", onboardingPath = "legacy_profile") {
  const path = normalizeAylaOnboardingPath(onboardingPath);
  if (path === "starting_fresh") return "not_started";
  if (path === "diagnostic_test") return "diagnostic_pending";
  const key = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) return "not_specified";
  if (!STUDY_STAGES.has(key)) {
    throw onboardingError("Choose one of the available study-stage options", "INVALID_STUDY_STAGE");
  }
  return key;
}

export function normalizeAylaOnboardingSubmission(input = {}, { examDefinition = {} } = {}) {
  const onboardingPath = normalizeAylaOnboardingPath(
    input.onboardingPath || input.onboarding_path || input.startingPath || input.starting_path,
  );
  if (!examDefinition?.id || !Array.isArray(examDefinition.systems)) {
    throw onboardingError("A supported exam definition is required", "INVALID_ONBOARDING_EXAM");
  }

  const base = {
    onboardingPath,
    onboarding_path: onboardingPath,
    studyStage: normalizeAylaStudyStage(input.studyStage || input.study_stage, onboardingPath),
    selectedWeakAreas: [],
    currentScore: 0,
    qbankCompleted: 0,
    qbankAverage: 0,
    baselineRecordedAt: null,
    serverVerifiedBaseline: false,
  };

  if (onboardingPath === "diagnostic_test") {
    return {
      ...base,
      onboardingStatus: "diagnostic_pending",
      baselineSource: "awaiting_verified_diagnostic",
      baselineConfidence: "pending",
    };
  }

  if (onboardingPath === "starting_fresh") {
    return {
      ...base,
      onboardingStatus: "ready",
      baselineSource: "new_student_self_report",
      baselineConfidence: "provisional",
    };
  }

  const selectedWeakAreas = matchingExamSystems(
    input.selectedWeakAreas || input.weakAreas || input.weak_areas,
    examDefinition,
  );

  if (onboardingPath === "quick_profile") {
    return {
      ...base,
      onboardingStatus: "ready",
      selectedWeakAreas,
      qbankCompleted: presetPercent(
        input.qbankCompleted ?? input.qbank_completed,
        QBANK_COMPLETION_PRESETS,
        "QBank completion",
      ),
      qbankAverage: presetPercent(
        input.qbankAverage ?? input.qbank_average,
        QBANK_AVERAGE_PRESETS,
        "QBank average",
      ),
      baselineSource: "self_reported_starting_profile",
      baselineConfidence: "provisional",
    };
  }

  const currentScore = percent(input.currentScore ?? input.current_score, 0);
  return {
    ...base,
    onboardingStatus: "ready",
    selectedWeakAreas,
    currentScore,
    qbankCompleted: percent(input.qbankCompleted ?? input.qbank_completed, 0),
    qbankAverage: percent(input.qbankAverage ?? input.qbank_average, 0),
    baselineSource: cleanText(
      input.baselineSource || input.baseline_source || (currentScore > 0 ? "diagnostic_global_score" : "awaiting_verified_baseline"),
      120,
    ),
    baselineConfidence: currentScore > 0 ? "reported_score" : "provisional",
    baselineRecordedAt: currentScore > 0 ? cleanText(input.baselineRecordedAt || input.baseline_recorded_at, 80) || new Date().toISOString() : null,
  };
}

function questionSystem(question = {}, examDefinition = {}) {
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object" ? question.taxonomy : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object" ? taxonomy.labels : {};
  const systems = cleanList(examDefinition.systems || [], 100);
  const byKey = new Map(systems.map((system) => [systemKey(system), system]));
  const candidates = [
    question.system_label,
    question.systemLabel,
    labels.system,
    labels.system_label,
    taxonomy.system_label,
    taxonomy.systemLabel,
    question.system_key,
    question.systemKey,
    taxonomy.system_key,
    taxonomy.systemKey,
    question.system,
  ];
  for (const candidate of candidates) {
    const match = byKey.get(systemKey(candidate));
    if (match) return match;
  }
  return null;
}

export function buildAylaVerifiedDiagnosticBaseline({
  session = {},
  questions = [],
  examDefinition = {},
  recordedAt = null,
} = {}) {
  if (String(session.purpose || "") !== "baseline_diagnostic" || String(session.status || "") !== "submitted") {
    throw onboardingError("Only a submitted baseline diagnostic can create a verified baseline", "DIAGNOSTIC_NOT_SUBMITTED");
  }
  const timestamp = recordedAt || session.submittedAt || session.updatedAt || new Date().toISOString();
  const questionsById = new Map((Array.isArray(questions) ? questions : []).map((question) => [String(question.id), question]));
  const rows = new Map();

  for (const mapping of Array.isArray(session.questions) ? session.questions : []) {
    const question = questionsById.get(String(mapping.contentQuestionId || mapping.content_question_id));
    const system = questionSystem(question || {}, examDefinition);
    if (!system) continue;
    const answer = session.answers?.[String(mapping.ref)];
    const row = rows.get(system) || { system, correct: 0, answered: 0, total: 0 };
    row.total += 1;
    if (answer) row.answered += 1;
    if (answer?.correct === true) row.correct += 1;
    rows.set(system, row);
  }

  const ordered = [...rows.values()]
    .map((row) => ({
      ...row,
      score: row.total ? Math.round((row.correct / row.total) * 100) : 0,
    }))
    .sort((left, right) => left.score - right.score || right.total - left.total || left.system.localeCompare(right.system));

  const systemBaselines = Object.fromEntries(ordered.map((row) => [row.system, {
    score: row.score,
    correct: row.correct,
    answered: row.answered,
    total: row.total,
    source: "verified_baseline_diagnostic",
    serverVerified: true,
    recordedAt: timestamp,
  }]));
  const expectedSystems = cleanList(examDefinition.systems || [], 100);
  const mappedQuestionCount = ordered.reduce((sum, row) => sum + row.total, 0);

  return {
    currentScore: Math.max(0, Math.min(100, Number(session.scorePercent || 0))),
    systemBaselines,
    weakAreas: ordered.filter((row) => row.score < 70).slice(0, 6).map((row) => row.system),
    baselineSource: "verified_baseline_diagnostic",
    baselineConfidence: "verified",
    baselineRecordedAt: timestamp,
    serverVerifiedBaseline: true,
    onboardingPath: "diagnostic_test",
    onboardingStatus: "complete",
    studyStage: "diagnostic_complete",
    diagnosticSessionId: session.id || null,
    onboardingCompletedAt: timestamp,
    diagnosticCoverage: {
      questionCount: Number(session.questionCount || session.questions?.length || 0),
      answeredCount: Number(session.answeredCount || 0),
      mappedQuestionCount,
      systemsCovered: ordered.length,
      systemsExpected: expectedSystems.length,
      coveragePercent: expectedSystems.length ? Math.round((ordered.length / expectedSystems.length) * 100) : 0,
    },
  };
}

export const AYLA_ONBOARDING_PRESETS = Object.freeze({
  qbankCompletion: [...QBANK_COMPLETION_PRESETS],
  qbankAverage: [...QBANK_AVERAGE_PRESETS],
  studyStages: [...STUDY_STAGES],
  paths: [...ONBOARDING_PATHS].filter((path) => path !== "legacy_profile"),
});
