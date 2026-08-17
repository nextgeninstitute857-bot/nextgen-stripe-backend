function clean(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function assignmentKey(row = {}) {
  return [
    clean(row.category || row.type),
    clean(row.system),
    clean(row.subsystem),
    clean(row.topic),
    clean(row.title),
  ].join("|");
}

function active(rows = []) {
  return rows.filter((row) => !["completed", "cancelled", "canceled", "superseded", "moved"].includes(clean(row.status || "pending")));
}

function focus(plan = {}) {
  return [plan.focusSystem || plan.systemFocus, plan.focusSubsystem || plan.subsystemFocus, plan.focusTopic || plan.topicFocus]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" — ");
}

export function buildAylaPlanChangeNotice(input = {}) {
  const previousPlan = input.previousPlan;
  if (!previousPlan) return null;
  const currentPlan = input.currentPlan || {};
  const previousAssignments = Array.isArray(input.previousAssignments) ? input.previousAssignments : [];
  const currentAssignments = Array.isArray(input.currentAssignments) ? input.currentAssignments : [];
  const previousActive = active(previousAssignments);
  const currentActive = active(currentAssignments);
  const previousKeys = new Set(previousActive.map(assignmentKey));
  const currentKeys = new Set(currentActive.map(assignmentKey));
  const addedCount = currentActive.filter((row) => !previousKeys.has(assignmentKey(row))).length;
  const movedOrRemovedCount = previousActive.filter((row) => !currentKeys.has(assignmentKey(row))).length;
  const unchangedCount = currentActive.filter((row) => previousKeys.has(assignmentKey(row))).length;
  const completedHistoryPreservedCount = previousAssignments.filter((row) => clean(row.status) === "completed").length;
  const previousFocus = focus(previousPlan);
  const currentFocus = focus(currentPlan);
  const focusChanged = Boolean(previousFocus && currentFocus && previousFocus !== currentFocus);
  const changedCount = addedCount + movedOrRemovedCount;
  const reason = String(input.reason || "adaptive_rebuild");

  return {
    type: "roadmap_updated",
    title: "Your roadmap was updated",
    message: changedCount
      ? `${changedCount} current or future task${changedCount === 1 ? "" : "s"} changed${focusChanged ? ` and the focus moved to ${currentFocus}` : ""}. Completed work was preserved.`
      : "The roadmap was recalculated, but your current task sequence did not need to change. Completed work was preserved.",
    because: reason === "student_request"
      ? "You asked AylaMed to rebuild future work using the latest verified progress."
      : reason === "personal_tutor_recommendation"
        ? "The Personal Tutor applied a version-checked recommendation to the current and future plan."
        : "New verified progress, unfinished work, or availability changed the adaptive plan.",
    next: currentActive.length
      ? "Open Today to continue with the first active task in the updated sequence."
      : "No additional task is required today; AylaMed will prepare the next study day.",
    reason,
    addedCount,
    movedOrRemovedCount,
    unchangedCount,
    completedHistoryPreserved: true,
    completedHistoryPreservedCount,
    previousFocus,
    currentFocus,
    focusChanged,
    createdAt: new Date().toISOString(),
  };
}

