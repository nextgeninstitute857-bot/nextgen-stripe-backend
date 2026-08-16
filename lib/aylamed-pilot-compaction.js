function values(collection) {
  return collection && typeof collection === "object"
    ? Object.values(collection)
    : [];
}

function studentId(row = {}) {
  return String(row.studentId || row.student_id || "");
}

function dailyPlanId(row = {}) {
  return String(row.dailyPlanId || row.daily_plan_id || "");
}

function isCompleted(row = {}) {
  return ["completed", "complete"].includes(String(row.status || "").toLowerCase())
    || Boolean(row.completedAt || row.completed_at);
}

function planRank(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const statusRank = {
    in_progress: 5,
    active: 4,
    pending: 3,
    scheduled: 2,
    superseded: 1,
    cancelled: 0,
  }[status] ?? 2;
  const version = Number(row.version || 0);
  const timestamp = Date.parse(row.updatedAt || row.updated_at || row.createdAt || row.created_at || 0) || 0;
  return [statusRank, version, timestamp, String(row.id || "")];
}

function laterPlan(left, right) {
  const leftRank = planRank(left);
  const rightRank = planRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] === rightRank[index]) continue;
    return leftRank[index] > rightRank[index] ? left : right;
  }
  return right;
}

/**
 * Remove duplicate, non-completed roadmap snapshots created for private pilot
 * profiles while preserving all completed learning history and all ordinary
 * student records. The retained plan for each pilot/date is the strongest and
 * most recent non-completed version.
 */
export function compactAylaPrivatePilotPlans(db = {}) {
  const pilotStudentIds = new Set(
    values(db.aylaPilotCohorts)
      .filter((row) => row.private === true)
      .flatMap((row) => Array.isArray(row.studentIds) ? row.studentIds : [])
      .map(String)
      .filter(Boolean),
  );

  if (!pilotStudentIds.size) {
    return {
      changed: false,
      pilot_student_count: 0,
      plans_removed: 0,
      assignments_removed: 0,
    };
  }

  const assignments = values(db.aylaResourceAssignments);
  const completedAssignmentPlanIds = new Set(
    assignments
      .filter((row) => pilotStudentIds.has(studentId(row)) && isCompleted(row))
      .map(dailyPlanId)
      .filter(Boolean),
  );
  const plans = values(db.aylaDailyPlans);
  const retainedPlanIds = new Set();
  const removablePlanIds = new Set();
  const groups = new Map();

  for (const plan of plans) {
    if (!pilotStudentIds.has(studentId(plan))) {
      retainedPlanIds.add(String(plan.id));
      continue;
    }
    const key = `${studentId(plan)}::${String(plan.date || "undated")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(plan);
  }

  for (const rows of groups.values()) {
    const historical = rows.filter((row) => (
      isCompleted(row) || completedAssignmentPlanIds.has(String(row.id || ""))
    ));
    for (const row of historical) retainedPlanIds.add(String(row.id));

    const current = rows
      .filter((row) => !historical.includes(row))
      .reduce((selected, row) => selected ? laterPlan(selected, row) : row, null);
    if (current?.id) retainedPlanIds.add(String(current.id));

    for (const row of rows) {
      const id = String(row.id || "");
      if (id && !retainedPlanIds.has(id)) removablePlanIds.add(id);
    }
  }

  if (!removablePlanIds.size) {
    return {
      changed: false,
      pilot_student_count: pilotStudentIds.size,
      plans_removed: 0,
      assignments_removed: 0,
    };
  }

  db.aylaDailyPlans = Object.fromEntries(
    Object.entries(db.aylaDailyPlans || {})
      .filter(([, row]) => !removablePlanIds.has(String(row?.id || ""))),
  );

  let assignmentsRemoved = 0;
  db.aylaResourceAssignments = Object.fromEntries(
    Object.entries(db.aylaResourceAssignments || {})
      .filter(([, row]) => {
        const remove = pilotStudentIds.has(studentId(row))
          && removablePlanIds.has(dailyPlanId(row))
          && !isCompleted(row);
        if (remove) assignmentsRemoved += 1;
        return !remove;
      }),
  );

  return {
    changed: true,
    pilot_student_count: pilotStudentIds.size,
    plans_removed: removablePlanIds.size,
    assignments_removed: assignmentsRemoved,
  };
}
