function clampCount(value, maximum = Number.POSITIVE_INFINITY) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(maximum, numeric));
}

/**
 * Convert per-day checklist state into honest, incremental course progress.
 * A fully completed day counts as one day. An in-progress day contributes the
 * fraction of its required tasks that are complete.
 */
export function summarizeRoadmapProgress(dayRows = []) {
  const rows = Array.isArray(dayRows) ? dayRows : [];
  let completedDays = 0;
  let completedDayEquivalents = 0;
  let completedTasks = 0;
  let totalTasks = 0;

  for (const row of rows) {
    const requiredTasks = clampCount(row?.required_task_count);
    const requiredCompleted = clampCount(row?.required_completed_count, requiredTasks);
    const completed = Boolean(row?.completed);

    if (completed) completedDays += 1;
    completedDayEquivalents += completed
      ? 1
      : requiredTasks > 0
        ? requiredCompleted / requiredTasks
        : 0;

    totalTasks += requiredTasks;
    completedTasks += completed ? requiredTasks : requiredCompleted;
  }

  const totalDays = rows.length;
  const progressPercentage = totalDays > 0
    ? Math.round((completedDayEquivalents / totalDays) * 1000) / 10
    : 0;

  return {
    total_days: totalDays,
    completed_days: completedDays,
    completed_day_equivalents: Math.round(completedDayEquivalents * 1000) / 1000,
    remaining_days: Math.max(0, totalDays - completedDays),
    completed_tasks: completedTasks,
    total_tasks: totalTasks,
    progress_percentage: progressPercentage,
  };
}
