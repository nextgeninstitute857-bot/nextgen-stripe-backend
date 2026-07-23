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

function boundedNumber(value, minimum = 0, maximum = 100, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeOnboardingPath(student = {}) {
  try {
    return normalizeAylaOnboardingPath(
      student.onboardingPath || student.onboarding_path || "legacy_profile",
    );
  } catch {
    return "legacy_profile";
  }
}

function qbankAverageBand(value = 0) {
  const score = Math.round(boundedNumber(value));
  if (!score) return null;
  if (score <= 35) return "Below 40%";
  if (score <= 45) return "40–49%";
  if (score <= 55) return "50–59%";
  if (score <= 65) return "60–69%";
  return "70% or higher";
}

function activeRoadmapRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !["cancelled", "superseded"].includes(String(row?.status || "").toLowerCase()))
    .sort((left, right) => (
      String(left.scheduledDate || left.scheduled_date || "").localeCompare(
        String(right.scheduledDate || right.scheduled_date || ""),
      )
      || String(left.createdAt || left.created_at || "").localeCompare(String(right.createdAt || right.created_at || ""))
      || String(left.id || "").localeCompare(String(right.id || ""))
    ));
}

export function reconcileAylaRoadmapOutline({
  existingTasks = [],
  nextTasks = [],
  studentId = "",
  fromDate = "",
  generationId = "",
  reason = "adaptive_refresh",
  now = null,
} = {}) {
  const ownerId = cleanText(studentId, 160);
  if (!ownerId) throw onboardingError("A student is required to refresh the roadmap outline", "INVALID_ROADMAP_STUDENT");
  const timestamp = now || new Date().toISOString();
  const effectiveFromDate = cleanText(fromDate, 10) || timestamp.slice(0, 10);
  const effectiveGenerationId = cleanText(generationId, 180) || `AYLA-ROADMAP-${timestamp}`;
  const owned = (Array.isArray(existingTasks) ? existingTasks : [])
    .filter((item) => String(item?.studentId || item?.student_id || "") === ownerId);
  const updates = [];
  let preservedCompleted = 0;
  let preservedPast = 0;
  let supersededFuture = 0;

  const projectedExisting = owned.map((raw) => {
    const item = { ...raw };
    const status = String(item.status || "").toLowerCase();
    const date = String(item.scheduledDate || item.scheduled_date || "").slice(0, 10);
    if (["completed", "done"].includes(status)) {
      preservedCompleted += 1;
      return item;
    }
    if (["cancelled", "superseded"].includes(status)) return item;
    if (date && date < effectiveFromDate) {
      preservedPast += 1;
      return item;
    }
    if (!(Array.isArray(nextTasks) && nextTasks.length)) return item;
    const updated = {
      ...item,
      status: "Superseded",
      supersededAt: timestamp,
      supersededReason: cleanText(reason, 160) || "adaptive_refresh",
      replacedByGenerationId: effectiveGenerationId,
      updatedAt: timestamp,
    };
    updates.push(updated);
    supersededFuture += 1;
    return updated;
  });

  const generatedTasks = (Array.isArray(nextTasks) ? nextTasks : []).map((item) => ({
    ...item,
    studentId: ownerId,
    roadmapGenerationId: effectiveGenerationId,
    generatedFrom: cleanText(reason, 160) || "adaptive_refresh",
    completedHistoryProtected: true,
    createdAt: item.createdAt || timestamp,
    updatedAt: timestamp,
  }));

  return {
    generationId: effectiveGenerationId,
    updates,
    generatedTasks,
    activeTasks: activeRoadmapRows([...projectedExisting, ...generatedTasks]),
    preservedCompleted,
    preservedPast,
    supersededFuture,
    completedHistoryProtected: true,
    futureOnly: true,
  };
}

function sevenDayOutline(rows = [], fromDate = "") {
  const effectiveFromDate = cleanText(fromDate, 10);
  const grouped = new Map();
  for (const row of activeRoadmapRows(rows)
    .filter((item) => !["completed", "done"].includes(String(item?.status || "").toLowerCase()))
    .filter((item) => {
      const date = cleanText(item?.scheduledDate || item?.scheduled_date, 10);
      return date && (!effectiveFromDate || date >= effectiveFromDate);
    })) {
    const date = cleanText(row.scheduledDate || row.scheduled_date || "Unscheduled", 40) || "Unscheduled";
    if (!grouped.has(date) && grouped.size >= 7) continue;
    const day = grouped.get(date) || {
      date,
      dayLabel: cleanText(row.dayLabel || row.day_label, 40),
      taskCount: 0,
      plannedMinutes: 0,
      focusSystems: [],
      tasks: [],
    };
    day.taskCount += 1;
    day.plannedMinutes += Math.max(0, Math.round(boundedNumber(
      row.durationMinutes ?? row.duration_minutes ?? row.estimatedMinutes ?? row.estimated_minutes,
      0,
      960,
      0,
    )));
    const system = cleanText(row.system, 140);
    if (system && !day.focusSystems.includes(system)) day.focusSystems.push(system);
    if (day.tasks.length < 4) {
      day.tasks.push({
        id: cleanText(row.id, 160) || null,
        title: cleanText(row.title || row.topic || row.category || "Study task", 300),
        category: cleanText(row.category || row.taskType || row.task_type, 120) || null,
        system: system || null,
        durationMinutes: Math.max(0, Math.round(boundedNumber(
          row.durationMinutes ?? row.duration_minutes ?? row.estimatedMinutes ?? row.estimated_minutes,
          0,
          960,
          0,
        ))),
        status: cleanText(row.status || "Pending", 60),
      });
    }
    grouped.set(date, day);
  }
  return [...grouped.values()].map((day) => ({
    ...day,
    focusSystems: day.focusSystems.slice(0, 4),
  }));
}

function verifiedSystemWeakAreas(student = {}) {
  const baselines = student.systemBaselines || student.system_baselines || {};
  return Object.entries(baselines)
    .map(([system, raw]) => {
      const row = raw && typeof raw === "object" ? raw : {};
      return {
        system: cleanText(system, 140),
        topic: null,
        score: Math.round(boundedNumber(row.score, 0, 100, 0)),
        correct: Math.max(0, Math.round(boundedNumber(row.correct, 0, 10000, 0))),
        total: Math.max(0, Math.round(boundedNumber(row.total, 0, 10000, 0))),
        evidence: "server_verified_diagnostic",
        confidence: "verified",
      };
    })
    .filter((row) => row.system && row.score < 70)
    .sort((left, right) => left.score - right.score || right.total - left.total || left.system.localeCompare(right.system));
}

function projectedWeakAreas(student = {}, weakAreaLogs = [], verified = false) {
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const system = cleanText(row.system || row.systemName || row.topic, 140);
    const topic = cleanText(row.topic, 180);
    const key = `${system.toLowerCase()}|${topic.toLowerCase()}`;
    if (!system || seen.has(key)) return;
    seen.add(key);
    rows.push({
      system,
      topic: topic || null,
      score: Number.isFinite(Number(row.score)) ? Math.round(boundedNumber(row.score)) : null,
      correct: Number.isFinite(Number(row.correct)) ? Math.max(0, Number(row.correct)) : null,
      total: Number.isFinite(Number(row.total)) ? Math.max(0, Number(row.total)) : null,
      evidence: verified ? "server_verified_diagnostic" : "provisional_self_report",
      confidence: verified ? "verified" : "provisional",
    });
  };

  if (verified) {
    verifiedSystemWeakAreas(student).forEach(add);
    (Array.isArray(weakAreaLogs) ? weakAreaLogs : [])
      .filter((row) => row?.serverVerified === true || row?.projectionType === "verified_adaptive_core")
      .filter((row) => String(row?.status || "Open").toLowerCase() !== "resolved")
      .forEach(add);
  } else {
    cleanList(student.weakAreas || student.weak_areas || student.selectedWeakAreas, 6)
      .forEach((system) => add({ system }));
  }
  return rows.slice(0, 6);
}

/**
 * Produce one evidence-aware starting report for every onboarding path.
 *
 * A verified diagnostic may show its measured percentage. Quick-profile and
 * starting-fresh paths deliberately do not manufacture a readiness score or a
 * pass prediction; they show provisional/discovery evidence until verified
 * work replaces it.
 */
export function buildAylaStartingReadinessReport({
  student = {},
  recommendation = {},
  roadmapTasks = [],
  weakAreaLogs = [],
  examDefinition = {},
  generatedAt = null,
} = {}) {
  const onboardingPath = safeOnboardingPath(student);
  const verified = student.serverVerifiedBaseline === true || student.server_verified_baseline === true;
  const pendingDiagnostic = onboardingPath === "diagnostic_test"
    && !verified
    && String(student.onboardingStatus || student.onboarding_status || "").toLowerCase() !== "complete";
  const reportGeneratedAt = generatedAt || new Date().toISOString();
  const outline = sevenDayOutline(roadmapTasks, reportGeneratedAt.slice(0, 10));
  const weakAreas = projectedWeakAreas(student, weakAreaLogs, verified);
  const readinessScore = verified
    ? Math.round(boundedNumber(student.currentScore ?? student.current_score, 0, 100, 0))
    : null;

  const evidence = verified
    ? {
        kind: "server_verified_diagnostic",
        label: "Verified diagnostic",
        confidence: "verified",
        provisional: false,
      }
    : pendingDiagnostic
      ? {
          kind: "diagnostic_pending",
          label: "Diagnostic pending",
          confidence: "pending",
          provisional: true,
        }
      : onboardingPath === "starting_fresh"
        ? {
            kind: "discovery_start",
            label: "Starting from zero",
            confidence: "discovery",
            provisional: true,
          }
        : {
            kind: "provisional_self_report",
            label: onboardingPath === "quick_profile" ? "Provisional self-assessment" : "Reported starting profile",
            confidence: "provisional",
            provisional: true,
          };

  const primaryFocus = weakAreas[0]?.system
    || (pendingDiagnostic ? "Complete the starting diagnostic" : "Baseline discovery");
  const nextAction = pendingDiagnostic
    ? {
        kind: "complete_diagnostic",
        title: "Complete your sealed diagnostic",
        description: "AylaMed will replace this pending estimate with server-verified overall and system-level evidence.",
        route: "/dashboard/qbank?diagnostic=1",
      }
    : {
        kind: "open_personal_tutor",
        title: "Review your next move with Personal Tutor",
        description: verified
          ? `Begin with ${primaryFocus}; the Tutor and roadmap now use the same verified baseline.`
          : "The Tutor will validate provisional assumptions through real questions, reviews, and completion history.",
        route: "/dashboard/personal-tutor",
      };

  const coverage = student.diagnosticCoverage || student.diagnostic_coverage || null;
  const qbankAverage = Math.round(boundedNumber(student.qbankAverage ?? student.qbank_average, 0, 100, 0));
  const qbankCompleted = Math.round(boundedNumber(student.qbankCompleted ?? student.qbank_completed, 0, 100, 0));
  const examTrackId = cleanText(
    student.examTrackId || student.exam_track_id || examDefinition.id,
    120,
  );

  return {
    version: 1,
    generatedAt: reportGeneratedAt,
    studentId: cleanText(student.id || student.studentId || student.student_id, 160) || null,
    exam: {
      id: examTrackId || null,
      label: cleanText(examDefinition.label || student.exam || "Medical exam", 180),
      curriculumVersion: cleanText(
        examDefinition.curriculumVersion || student.curriculumVersion || student.curriculum_version,
        120,
      ) || null,
    },
    onboardingPath,
    evidence,
    readiness: {
      score: readinessScore,
      scoreLabel: verified ? "Starting diagnostic score" : null,
      scoreScale: verified ? "percent_correct_on_starting_diagnostic" : null,
      level: cleanText(recommendation.riskLevel || student.riskLevel || "Baseline Needed", 120),
      phase: cleanText(recommendation.phase || student.phase || student.roadmapMode, 160),
      passPrediction: false,
      passProbability: null,
    },
    reportedStartingPoint: {
      studyStage: cleanText(student.studyStage || student.study_stage, 120) || null,
      qbankCompleted,
      qbankAverage: qbankAverage || null,
      qbankAverageBand: qbankAverageBand(qbankAverage),
      verified: false,
    },
    diagnosticCoverage: coverage ? {
      questionCount: Math.max(0, Number(coverage.questionCount || coverage.question_count || 0)),
      mappedQuestionCount: Math.max(0, Number(coverage.mappedQuestionCount || coverage.mapped_question_count || 0)),
      systemsCovered: Math.max(0, Number(coverage.systemsCovered || coverage.systems_covered || 0)),
      systemsExpected: Math.max(0, Number(coverage.systemsExpected || coverage.systems_expected || 0)),
      coveragePercent: Math.max(0, Math.min(100, Number(coverage.coveragePercent || coverage.coverage_percent || 0))),
    } : null,
    weakAreas,
    noWeaknessInvented: weakAreas.length === 0,
    workload: {
      dailyHours: boundedNumber(recommendation.dailyHours ?? student.dailyHours ?? student.daily_hours, 1, 16, 4),
      weeklyStudyDays: boundedNumber(
        recommendation.weeklyStudyDays ?? student.weeklyStudyDays ?? student.weekly_study_days,
        1,
        7,
        6,
      ),
      dailyQuestionTarget: Math.max(0, Number(recommendation.dailyQuestionTarget || 0)),
      dailyFlashcardTarget: Math.max(0, Number(recommendation.dailyFlashcardTarget || 0)),
      weeklyAssessment: cleanText(recommendation.weeklyAssessment, 220) || null,
    },
    tutorBriefing: {
      primaryFocus,
      roadmapMode: cleanText(recommendation.roadmapMode || student.roadmapMode, 180),
      reason: cleanText(recommendation.reason, 1000),
      evidenceGuard: verified ? "verified_baseline" : "validate_provisional_start",
      authoritativeRoadmap: true,
      createsSecondPlan: false,
      forecastIsAuthoritativeExecution: false,
    },
    firstSevenDays: {
      kind: "adaptive_forecast",
      days: outline,
      dayCount: outline.length,
      taskCount: outline.reduce((sum, day) => sum + day.taskCount, 0),
      plannedMinutes: outline.reduce((sum, day) => sum + day.plannedMinutes, 0),
      readOnly: true,
      authoritativeExecution: false,
      executionRoute: "/dashboard/roadmap",
      completedHistoryProtected: true,
      futureOnlyAdaptation: true,
    },
    nextAction,
    routes: {
      today: "/dashboard/today",
      personalTutor: "/dashboard/personal-tutor",
      roadmap: "/dashboard/roadmap",
      roadmapExecution: "/dashboard/roadmap",
      weakAreas: "/dashboard/weak-areas",
    },
    safety: {
      serverVerifiedScoreOnly: true,
      provisionalEvidenceLabelled: true,
      noPassPrediction: true,
      completedHistoryProtected: true,
      examIsolated: Boolean(examTrackId),
    },
  };
}

export const AYLA_ONBOARDING_PRESETS = Object.freeze({
  qbankCompletion: [...QBANK_COMPLETION_PRESETS],
  qbankAverage: [...QBANK_AVERAGE_PRESETS],
  studyStages: [...STUDY_STAGES],
  paths: [...ONBOARDING_PATHS].filter((path) => path !== "legacy_profile"),
});
