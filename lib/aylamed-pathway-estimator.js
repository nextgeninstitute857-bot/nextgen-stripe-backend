const DAY_MS = 24 * 60 * 60 * 1000;

const EXAM_PROFILES = Object.freeze({
  usmle_step_1: Object.freeze({
    id: "usmle_step_1",
    label: "USMLE Step 1",
    coreQuestionTarget: 3600,
    estimatedLectureHours: 120,
    estimatedReadingHours: 80,
    assessmentReviewHours: 5,
    revisionCycleHours: 42,
    currentFormat: Object.freeze({
      effectiveFrom: "2026-05-14",
      totalItemsMaximum: 280,
      blocks: 14,
      minutesPerBlock: 30,
      itemsPerBlockMaximum: 20,
      testingSessionHours: 8,
      minimumBreakMinutes: 55,
      optionalTutorialMinutes: 5,
    }),
    previousFormat: Object.freeze({
      effectiveThrough: "2026-05-13",
      totalItemsMaximum: 280,
      blocks: 7,
      minutesPerBlock: 60,
      itemsPerBlockMaximum: 40,
      testingSessionHours: 8,
      minimumBreakMinutes: 45,
      optionalTutorialMinutes: 15,
    }),
  }),
});

function bounded(value, min, max, fallback = min) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function dateOnly(value = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function strictDateOnly(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? "" : raw;
}

function addDays(value, days) {
  const parsed = new Date(`${dateOnly(value)}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return dateOnly(parsed);
}

function daysBetween(start, end) {
  const startMs = new Date(`${dateOnly(start)}T12:00:00.000Z`).getTime();
  const endMs = new Date(`${dateOnly(end)}T12:00:00.000Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
}

function examFormat(profile, examDate) {
  return examDate && examDate < profile.currentFormat.effectiveFrom
    ? profile.previousFormat
    : profile.currentFormat;
}

function confidenceLabel(input = {}) {
  if (input.baselineVerified === true && Number(input.latestAssessmentPercent) > 0) return "high";
  if (Number(input.latestAssessmentPercent) > 0 || Number(input.qbankCompletedPercent) > 0) return "medium";
  return "low";
}

function questionMinutesPerItem(score) {
  if (score >= 68) return 4.25;
  if (score >= 60) return 5;
  if (score >= 50) return 5.75;
  return 6.5;
}

function assessmentCount(targetDays, score) {
  const base = targetDays <= 35 ? 4 : targetDays <= 70 ? 6 : 8;
  return score > 0 && score < 55 ? base + 1 : base;
}

function feasibility(requiredHours, availableHours) {
  if (!availableHours) return { key: "hours_needed", label: "Hours needed", ratio: null };
  const ratio = requiredHours / availableHours;
  if (ratio <= 0.82) return { key: "feasible_with_buffer", label: "Feasible with buffer", ratio };
  if (ratio <= 1) return { key: "demanding", label: "Demanding but feasible", ratio };
  if (ratio <= 1.2) return { key: "stretch", label: "Stretch — reduce scope or increase time", ratio };
  return { key: "not_currently_feasible", label: "Not currently feasible at the entered hours", ratio };
}

function roundHalf(value) {
  return Math.round(Number(value || 0) * 2) / 2;
}

function milestonePlan({
  targetDays,
  score,
  qbankCompleted,
  assessmentTotal,
  questionRemaining,
}) {
  const firstAssessmentDay = score > 0 ? Math.min(3, Math.max(1, Math.round(targetDays * 0.05))) : 1;
  const consolidationDay = Math.max(firstAssessmentDay + 1, Math.round(targetDays * 0.68));
  const finalReviewDay = Math.max(consolidationDay + 1, targetDays - 7);
  return [
    {
      key: "baseline",
      byDay: firstAssessmentDay,
      title: score > 0 ? "Confirm the starting baseline" : "Complete a verified diagnostic",
      outcome: "A verified system-level baseline replaces self-report where available.",
    },
    {
      key: "coverage",
      byDay: Math.max(firstAssessmentDay + 1, Math.round(targetDays * 0.35)),
      title: "Complete the first weak-system repair cycle",
      outcome: `Prioritize targeted concepts while progressing from ${qbankCompleted}% QBank completion toward ${Math.min(100, qbankCompleted + Math.round((questionRemaining / 3600) * 45))}%.`,
    },
    {
      key: "consolidation",
      byDay: consolidationDay,
      title: "Shift from coverage to mixed integration",
      outcome: `Use timed mixed work, incorrect review, and the first ${Math.max(2, Math.floor(assessmentTotal * 0.65))} readiness checkpoints.`,
    },
    {
      key: "final_review",
      byDay: finalReviewDay,
      title: "Begin final readiness review",
      outcome: "Stop large new resources; focus on repeated misses, official-format simulations, sleep, and exam logistics.",
    },
  ];
}

export function aylaExamPreparationProfile(examTrackId = "usmle_step_1") {
  const profile = EXAM_PROFILES[String(examTrackId || "").trim()];
  return profile ? structuredClone(profile) : null;
}

export function estimateAylaExamPathway(input = {}, { today = new Date() } = {}) {
  const examTrackId = String(input.examTrackId || input.exam_track_id || "usmle_step_1").trim();
  const profile = EXAM_PROFILES[examTrackId];
  if (!profile) {
    throw Object.assign(new Error("This exam does not yet have a validated pathway-estimation profile"), { statusCode: 409 });
  }
  const anchorDate = dateOnly(today);
  const requestedDays = bounded(input.targetDays ?? input.target_days, 14, 365, 90);
  const rawExamDate = String(input.examDate || input.exam_date || "").trim();
  const suppliedExamDate = rawExamDate ? strictDateOnly(rawExamDate) : "";
  if (rawExamDate && !suppliedExamDate) {
    throw Object.assign(new Error("Enter a valid exam date"), { statusCode: 400 });
  }
  if (suppliedExamDate && suppliedExamDate <= anchorDate) {
    throw Object.assign(new Error("The exam date must be after today"), { statusCode: 400 });
  }
  const targetDays = suppliedExamDate ? daysBetween(anchorDate, suppliedExamDate) : Math.round(requestedDays);
  const examDate = suppliedExamDate || addDays(anchorDate, targetDays);
  const weeklyStudyDays = Math.round(bounded(input.weeklyStudyDays ?? input.weekly_study_days, 1, 7, 6));
  const dailyHoursAvailable = bounded(input.dailyHoursAvailable ?? input.daily_hours_available ?? input.dailyHours ?? input.daily_hours, 0, 16, 0);
  const qbankCompleted = bounded(input.qbankCompletedPercent ?? input.qbank_completed_percent ?? input.qbankCompleted ?? input.qbank_completed, 0, 100, 0);
  const lectureCompleted = bounded(input.lectureCompletedPercent ?? input.lecture_completed_percent, 0, 100, 0);
  const readingCompleted = bounded(input.readingCompletedPercent ?? input.reading_completed_percent ?? input.contentCompletedPercent ?? input.content_completed_percent, 0, 100, 0);
  const latestAssessmentPercent = bounded(input.latestAssessmentPercent ?? input.latest_assessment_percent ?? input.currentScore ?? input.current_score, 0, 100, 0);
  const confidence = confidenceLabel({ ...input, qbankCompletedPercent: qbankCompleted, latestAssessmentPercent });

  const studyWeeks = targetDays / 7;
  const studyDays = Math.max(1, Math.floor(studyWeeks * weeklyStudyDays));
  const questionRemaining = Math.max(0, Math.round(profile.coreQuestionTarget * (1 - qbankCompleted / 100)));
  const questionHours = questionRemaining * questionMinutesPerItem(latestAssessmentPercent) / 60;
  const lectureHours = profile.estimatedLectureHours * (1 - lectureCompleted / 100);
  const readingHours = profile.estimatedReadingHours * (1 - readingCompleted / 100);
  const assessments = assessmentCount(targetDays, latestAssessmentPercent);
  const assessmentHours = assessments * profile.assessmentReviewHours;
  const revisionCycles = targetDays <= 35 ? 1 : 2;
  const revisionHours = revisionCycles * profile.revisionCycleHours;
  const evidencePenaltyHours = confidence === "low" ? 18 : confidence === "medium" ? 8 : 0;
  const rawHours = questionHours + lectureHours + readingHours + assessmentHours + revisionHours + evidencePenaltyHours;
  const lowerHours = roundHalf(rawHours * 0.86);
  const upperHours = roundHalf(rawHours * 1.14);
  const requiredHours = roundHalf(rawHours);
  const requiredDailyHours = roundHalf(requiredHours / studyDays);
  const availableHours = roundHalf(dailyHoursAvailable * studyDays);
  const feasibilityResult = feasibility(requiredHours, availableHours);
  const dailyQuestions = Math.ceil(questionRemaining / studyDays);
  const weeklyQuestions = dailyQuestions * weeklyStudyDays;

  const scopeAdvice = [];
  if (targetDays <= 35 && confidence === "low") {
    scopeAdvice.push("A one-month target is not supported by verified baseline evidence. Complete a diagnostic before treating this date as viable.");
  }
  if (requiredDailyHours > 10) {
    scopeAdvice.push("The calculated load exceeds a sustainable focused-study day for many students; extend the date or reduce passive resource coverage.");
  }
  if (lectureCompleted < 100) {
    scopeAdvice.push("Lectures should be assigned only for weak or uncovered blueprint areas, not watched indiscriminately.");
  }
  scopeAdvice.push("Readiness must be re-estimated after each verified assessment; no timeline is a pass guarantee.");

  return {
    model: "aylamed-transparent-workload-v1",
    exam: {
      id: profile.id,
      label: profile.label,
      examDate,
      targetDays,
      format: { ...examFormat(profile, examDate) },
    },
    inputs: {
      baselineVerified: input.baselineVerified === true,
      latestAssessmentPercent,
      qbankCompletedPercent: qbankCompleted,
      lectureCompletedPercent: lectureCompleted,
      readingCompletedPercent: readingCompleted,
      weeklyStudyDays,
      dailyHoursAvailable,
    },
    confidence: {
      level: confidence,
      reason: confidence === "high"
        ? "A server-verified assessment is available."
        : confidence === "medium"
          ? "Some performance or completion evidence is available, but the baseline is not fully verified."
          : "No verified assessment or meaningful completion history is available yet.",
    },
    workload: {
      estimatedHours: requiredHours,
      estimatedRangeHours: [lowerHours, upperHours],
      availableHours,
      requiredHoursPerStudyDay: requiredDailyHours,
      studyDays,
      components: {
        questions: { remaining: questionRemaining, estimatedHours: roundHalf(questionHours), dailyTarget: dailyQuestions, weeklyTarget: weeklyQuestions },
        lectures: { remainingPercent: 100 - lectureCompleted, estimatedHours: roundHalf(lectureHours), strategy: "Weak/uncovered blueprint areas only" },
        reading: { remainingPercent: 100 - readingCompleted, estimatedHours: roundHalf(readingHours), strategy: "Exact assigned pages plus linked notes" },
        assessments: { count: assessments, estimatedHours: roundHalf(assessmentHours), includesReview: true },
        revision: { cycles: revisionCycles, estimatedHours: roundHalf(revisionHours) },
        baselineDiscovery: { estimatedHours: evidencePenaltyHours },
      },
    },
    feasibility: {
      ...feasibilityResult,
      enteredDailyHours: dailyHoursAvailable,
      message: feasibilityResult.key === "not_currently_feasible"
        ? `This target needs about ${requiredDailyHours} focused hours per study day; the entered schedule provides ${dailyHoursAvailable}.`
        : `This target needs about ${requiredDailyHours} focused hours per study day across ${studyDays} study days.`,
    },
    milestones: milestonePlan({
      targetDays,
      score: latestAssessmentPercent,
      qbankCompleted,
      assessmentTotal: assessments,
      questionRemaining,
    }),
    aylaMedWillProvide: [
      "A daily roadmap constrained by the entered available hours",
      "Targeted QBank blocks and explanation-linked mistake review",
      "Private weak-area flashcards generated only from verified misses",
      "Exact-page reading and approved lecture assignments when mappings exist",
      "Assessment checkpoints and a refreshed estimate after verified results",
      "A visible explanation of what changed, why it changed, and what was actually delivered",
    ],
    scopeAdvice,
    disclaimer: "This is a workload and pathway estimate, not a prediction or guarantee of passing. Official NBME readiness evidence should take priority near exam day.",
  };
}

export function compareAylaExamPathways(input = {}, options = {}) {
  const horizons = Array.isArray(input.horizons) && input.horizons.length
    ? input.horizons
    : [30, 60, 90];
  return horizons.slice(0, 6).map((targetDays) => estimateAylaExamPathway({
    ...input,
    examDate: "",
    exam_date: "",
    targetDays,
  }, options));
}
