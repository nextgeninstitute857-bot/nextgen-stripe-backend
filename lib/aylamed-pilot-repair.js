import {
  canonicalStep1DiagnosticSystem,
  classifyStep1DiagnosticQuestion,
  diagnosticSessionUsesCurrentBlueprint,
} from "./aylamed-diagnostic.js";

export const AYLA_PILOT_FLOW_REPAIR_VERSION = "v258_verified_diagnostic_roadmap";

const FINISHED = new Set(["completed", "cancelled", "superseded", "abandoned"]);
const ACTIVE_REVISION = new Set(["pending", "due", "assigned", "review_again"]);

function clean(value = "", max = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function studentId(row = {}) {
  return clean(row.studentId || row.student_id, 180);
}

function status(row = {}, fallback = "pending") {
  return clean(row.status || fallback, 80).toLowerCase();
}

function belongsToCohort(row, studentIds) {
  return studentIds.has(studentId(row));
}

function diagnosticAnswers(session = {}) {
  return session.answers && typeof session.answers === "object"
    ? Object.keys(session.answers)
    : [];
}

function canonicalRevisionSystem(row = {}) {
  return canonicalStep1DiagnosticSystem(
    row.system || row.system_key || row.taxonomy?.system_key,
  ) || classifyStep1DiagnosticQuestion({
    ...row,
    title: row.topic || row.title || row.system || "",
    topic_key: row.topic || row.topic_key || "",
  });
}

function revisionIdentity(row = {}, canonicalSystem = "") {
  const source = clean(row.sourceType || row.source_type || "revision", 100).toLowerCase();
  const resource = clean(
    row.resourceId
      || row.resource_id
      || row.sourceResourceId
      || row.source_resource_id
      || row.contentQuestionId
      || row.content_question_id
      || row.sourceAttemptId
      || row.source_attempt_id,
    240,
  ).toLowerCase();
  const topic = clean(row.topic || row.title, 240).toLowerCase();
  if (!resource && !topic) return "";
  return [
    studentId(row),
    source,
    resource || topic,
    clean(canonicalSystem, 120).toLowerCase(),
  ].join("|");
}

function byOldestDueThenCreated(left, right) {
  return String(left.dueDate || left.due_date || "9999-12-31")
    .localeCompare(String(right.dueDate || right.due_date || "9999-12-31"))
    || String(left.createdAt || left.created_at || "")
      .localeCompare(String(right.createdAt || right.created_at || ""))
    || String(left.id || "").localeCompare(String(right.id || ""));
}

export function buildAylaPilotFlowRepairPlan({
  cohort = {},
  students = [],
  dailyPlans = [],
  assignments = [],
  revisionQueue = [],
  qbankSessions = [],
} = {}) {
  const cohortStudentIds = new Set(
    (Array.isArray(cohort.studentIds) ? cohort.studentIds : [])
      .map((value) => clean(value, 180))
      .filter(Boolean),
  );
  const cohortIsEligible = cohort.private === true
    && String(cohort.status || "").toLowerCase() === "active"
    && ["usmle_step_1", "usmle-step-1"].includes(
      clean(cohort.examTrackId || cohort.exam_track_id, 120).toLowerCase(),
    )
    && cohortStudentIds.size > 0;
  const currentStudents = (Array.isArray(students) ? students : [])
    .filter((row) => cohortStudentIds.has(clean(row?.id, 180)));

  const activePlans = (Array.isArray(dailyPlans) ? dailyPlans : [])
    .filter((row) => belongsToCohort(row, cohortStudentIds))
    .filter((row) => !FINISHED.has(status(row, "active")));
  const unfinishedAssignments = (Array.isArray(assignments) ? assignments : [])
    .filter((row) => belongsToCohort(row, cohortStudentIds))
    .filter((row) => !FINISHED.has(status(row)));
  const completedAssignments = (Array.isArray(assignments) ? assignments : [])
    .filter((row) => belongsToCohort(row, cohortStudentIds))
    .filter((row) => status(row) === "completed");

  const invalidDiagnostics = (Array.isArray(qbankSessions) ? qbankSessions : [])
    .filter((row) => belongsToCohort(row, cohortStudentIds))
    .filter((row) => String(row.purpose || "") === "baseline_diagnostic")
    .filter((row) => status(row, "in_progress") === "in_progress")
    .filter((row) => !diagnosticSessionUsesCurrentBlueprint(row));
  const answeredInvalidDiagnostics = invalidDiagnostics
    .filter((row) => diagnosticAnswers(row).length > 0);
  const zeroAnswerInvalidDiagnostics = invalidDiagnostics
    .filter((row) => diagnosticAnswers(row).length === 0);

  const activeRevisions = (Array.isArray(revisionQueue) ? revisionQueue : [])
    .filter((row) => belongsToCohort(row, cohortStudentIds))
    .filter((row) => ACTIVE_REVISION.has(status(row)));
  const revisionRows = activeRevisions.map((row) => ({
    row,
    canonicalSystem: canonicalRevisionSystem(row),
  }));
  const unsafeRevisionIds = revisionRows
    .filter((entry) => !entry.canonicalSystem)
    .map((entry) => String(entry.row.id));
  const canonicalRevisionUpdates = revisionRows
    .filter((entry) => entry.canonicalSystem)
    .filter((entry) => canonicalStep1DiagnosticSystem(
      entry.row.system || entry.row.system_key || entry.row.taxonomy?.system_key,
    ) !== entry.canonicalSystem)
    .map((entry) => ({
      id: String(entry.row.id),
      system: entry.canonicalSystem,
    }));

  const duplicateRevisionIds = [];
  const revisionGroups = new Map();
  for (const entry of revisionRows.filter((item) => item.canonicalSystem)) {
    const identity = revisionIdentity(entry.row, entry.canonicalSystem);
    if (!identity) continue;
    if (!revisionGroups.has(identity)) revisionGroups.set(identity, []);
    revisionGroups.get(identity).push(entry.row);
  }
  for (const rows of revisionGroups.values()) {
    if (rows.length < 2) continue;
    rows.sort(byOldestDueThenCreated);
    duplicateRevisionIds.push(...rows.slice(1).map((row) => String(row.id)));
  }

  const alreadyApplied = String(cohort.pilotFlowRepairVersion || "")
    === AYLA_PILOT_FLOW_REPAIR_VERSION;
  const blocked = !cohortIsEligible
    ? "cohort_not_active_private_step1"
    : currentStudents.length !== cohortStudentIds.size
      ? "cohort_student_records_incomplete"
      : answeredInvalidDiagnostics.length
        ? "answered_legacy_diagnostic_requires_manual_review"
        : null;

  return {
    version: AYLA_PILOT_FLOW_REPAIR_VERSION,
    cohortId: clean(cohort.id, 180) || null,
    cohortIsEligible,
    eligible: !blocked,
    blocked,
    alreadyApplied,
    studentIds: [...cohortStudentIds],
    scenarioKeys: currentStudents.map((row) => clean(row.pilotScenarioKey, 120)).filter(Boolean),
    activePlanIds: activePlans.map((row) => String(row.id)),
    unfinishedAssignmentIds: unfinishedAssignments.map((row) => String(row.id)),
    completedAssignmentIds: completedAssignments.map((row) => String(row.id)),
    zeroAnswerInvalidDiagnosticIds: zeroAnswerInvalidDiagnostics.map((row) => String(row.id)),
    answeredInvalidDiagnosticIds: answeredInvalidDiagnostics.map((row) => String(row.id)),
    unsafeRevisionIds,
    duplicateRevisionIds: [...new Set(duplicateRevisionIds)],
    canonicalRevisionUpdates,
    counts: {
      students: cohortStudentIds.size,
      activePlansToSupersede: activePlans.length,
      unfinishedAssignmentsToSupersede: unfinishedAssignments.length,
      completedAssignmentsPreserved: completedAssignments.length,
      zeroAnswerDiagnosticsToSupersede: zeroAnswerInvalidDiagnostics.length,
      answeredDiagnosticsBlocking: answeredInvalidDiagnostics.length,
      unsafeRevisionsToSupersede: unsafeRevisionIds.length,
      duplicateRevisionsToSupersede: [...new Set(duplicateRevisionIds)].length,
      revisionsToCanonicalize: canonicalRevisionUpdates.length,
    },
    safeguards: {
      completedAssignmentsPreserved: true,
      questionAttemptsPreserved: true,
      assessmentAttemptsPreserved: true,
      scoresPreserved: true,
      notebookHistoryPreserved: true,
      paymentsUntouched: true,
      lmsUntouched: true,
      crmUntouched: true,
      ordinaryStudentsUntouched: true,
    },
  };
}
