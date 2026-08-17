function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value, fallback = 1) {
  return Math.max(1, Math.round(finiteNumber(value, fallback)));
}

function roundHours(minutes) {
  return Math.round((Math.max(0, minutes) / 60) * 10) / 10;
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

export function buildAylaScheduleRisk(input = {}) {
  const backlogCount = Math.max(0, Math.round(finiteNumber(input.backlogCount, 0)));
  const backlogMinutes = Math.max(0, Math.round(finiteNumber(input.backlogMinutes, 0)));
  const dailyCapacityMinutes = positiveInteger(input.dailyCapacityMinutes, 180);
  const studyDaysRemaining = positiveInteger(input.studyDaysRemaining, 1);
  const daysToTarget = Math.max(0, Math.round(finiteNumber(input.daysToTarget, studyDaysRemaining)));
  const targetDate = String(input.targetDate || "").slice(0, 10);
  const currentDate = String(input.currentDate || "").slice(0, 10);
  const targetDatePassed = /^\d{4}-\d{2}-\d{2}$/.test(targetDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(currentDate)
    && targetDate < currentDate;
  const targetLabel = String(input.targetLabel || "target date").trim() || "target date";
  const requiredDailyMinutes = Math.max(0, Math.round(finiteNumber(input.requiredDailyMinutes, 0)));
  const riskMultiplier = Math.max(1, finiteNumber(input.riskMultiplier, 1.15));
  const lowCompletion = input.lowCompletion === true;

  const backlogHours = roundHours(backlogMinutes);
  const studyDaysBehind = backlogMinutes ? Math.max(1, Math.ceil(backlogMinutes / dailyCapacityMinutes)) : 0;
  const rawRecoveryExtraDailyMinutes = backlogMinutes && !targetDatePassed
    ? Math.max(1, Math.ceil(backlogMinutes / studyDaysRemaining))
    : 0;
  const scheduleResetRequired = targetDatePassed
    || (studyDaysRemaining <= 1 && rawRecoveryExtraDailyMinutes > Math.max(120, Math.round(dailyCapacityMinutes * 0.5)));
  const recoveryExtraDailyMinutes = scheduleResetRequired ? 0 : rawRecoveryExtraDailyMinutes;
  const capacityExtraDailyMinutes = Math.max(0, requiredDailyMinutes - dailyCapacityMinutes);
  const extraDailyMinutes = scheduleResetRequired ? 0 : Math.max(recoveryExtraDailyMinutes, capacityExtraDailyMinutes);
  const projectedDelayStudyDays = backlogMinutes ? studyDaysBehind : 0;
  const capacityRisk = requiredDailyMinutes > dailyCapacityMinutes * riskMultiplier;
  const examNear = daysToTarget > 0 && daysToTarget <= 30;
  const highRisk = backlogMinutes >= dailyCapacityMinutes * 2 || (capacityRisk && examNear);
  const hasRisk = backlogMinutes > 0 || capacityRisk || lowCompletion;
  const level = highRisk ? "high" : hasRisk ? "medium" : "on_track";

  let title = "Your workload is currently manageable.";
  let message = "Complete today’s priority assignments and AylaMed will keep adapting future work.";
  if (hasRisk) {
    const unfinished = backlogCount
      ? `${plural(backlogCount, "unfinished task")} (${backlogHours} hours)`
      : "Your remaining priority workload";
    const delay = studyDaysBehind
      ? `At your current availability, that is about ${plural(studyDaysBehind, "study day")} behind.`
      : "Your planned workload is above the daily time currently available.";
    const recovery = targetDatePassed
      ? `Your ${targetLabel} has passed. At your current availability, clearing this work requires about ${plural(studyDaysBehind, "additional study day")}. Update the target date now so AylaMed can distribute the work safely.`
      : scheduleResetRequired
        ? `Only ${plural(studyDaysRemaining, "study day")} remains before your ${targetLabel}, while the unfinished work equals about ${plural(studyDaysBehind, "study day")}. Update the target date instead of attempting an unsafe same-day catch-up.`
      : extraDailyMinutes
        ? `Recovering before your ${targetLabel} requires about ${extraDailyMinutes} extra minutes on each remaining study day.`
        : "Complete today’s priority work to protect the remaining schedule.";
    title = highRisk ? "Your preparation is falling behind schedule." : "Your study schedule needs attention.";
    message = `${unfinished} need attention. ${delay} ${recovery}`;
  }

  return {
    level,
    title,
    message,
    targetLabel,
    targetDate,
    targetDatePassed,
    scheduleResetRequired,
    daysToTarget,
    backlogCount,
    backlogMinutes,
    backlogHours,
    dailyCapacityMinutes,
    studyDaysRemaining,
    requiredDailyMinutes,
    studyDaysBehind,
    projectedDelayStudyDays,
    recoveryExtraDailyMinutes,
    extraDailyMinutes,
    finalReviewBurdenMinutes: backlogMinutes,
    assessmentImpact: hasRisk
      ? "Unfinished learning can postpone readiness checks because AylaMed studies the weak area before testing it. If the work is left until the end, the same hours move into your final review days."
      : "Your current pace protects the planned learning and assessment sequence.",
    recoveryActions: hasRisk
      ? scheduleResetRequired
        ? [
            "Complete the highest-priority unfinished task today.",
            `Set a new realistic target date that includes at least ${plural(studyDaysBehind, "study day")} for the current backlog.`,
            "Confirm your daily availability so AylaMed can rebuild the learning and assessment sequence safely.",
          ]
        : [
            `Complete the highest-priority unfinished task today.`,
            extraDailyMinutes ? `Add ${extraDailyMinutes} minutes to each remaining study day until the backlog is cleared.` : "Keep the current daily study time protected.",
            "If that time is not realistic, update your availability or target date so AylaMed can rebuild the plan safely.",
          ]
      : [],
    choices: hasRisk
      ? ["Start the highest-priority task", "Update daily availability", "Review the target date"]
      : [],
  };
}

