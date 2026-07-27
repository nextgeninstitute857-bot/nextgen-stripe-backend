function cleanString(value = "", max = 180) {
  return String(value || "").trim().slice(0, max);
}

function cleanList(value) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(rows.map((item) => cleanString(item)).filter(Boolean))];
}

export function aylaPilotContentScope(resource = {}) {
  const accessScope = cleanString(
    resource.accessScope
      || resource.access_scope
      || resource.visibility
      || resource.visibility_scope,
    80,
  ).toLowerCase().replace(/[\s-]+/g, "_");
  const pilotOnly = resource.pilotOnly === true
    || resource.pilot_only === true
    || ["private_pilot", "pilot_only", "pilot"].includes(accessScope);
  return {
    accessScope: pilotOnly ? "private_pilot" : (accessScope || "standard"),
    pilotOnly,
    pilotCohortId: cleanString(
      resource.pilotCohortId
        || resource.pilot_cohort_id
        || resource.cohortId
        || resource.cohort_id,
    ),
    pilotStudentIds: cleanList(
      resource.pilotStudentIds
        || resource.pilot_student_ids
        || resource.allowedStudentIds
        || resource.allowed_student_ids,
    ),
  };
}

export function aylaPilotContentVisibleToStudent(resource = {}, student = {}) {
  const scope = aylaPilotContentScope(resource);
  if (!scope.pilotOnly) return true;
  if (student.pilotTest !== true && student.pilot_test !== true) return false;

  const studentId = cleanString(student.id);
  if (scope.pilotStudentIds.length && !scope.pilotStudentIds.includes(studentId)) return false;

  const studentCohortId = cleanString(student.pilotCohortId || student.pilot_cohort_id);
  if (scope.pilotCohortId && scope.pilotCohortId !== studentCohortId) return false;
  return true;
}
