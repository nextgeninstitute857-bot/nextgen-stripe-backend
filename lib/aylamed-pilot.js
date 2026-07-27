const STEP1_PILOT_PLAN_ID = "AYLA-PLAN-PILOT-STEP1";
const STEP1_PILOT_CONFIRMATION = "CREATE PRIVATE STEP1 PILOT";
const STEP1_PILOT_MAX_DAYS = 14;

function clean(value = "", max = 240) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function dateOnly(value = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const parsed = new Date(`${dateOnly(value)}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return dateOnly(parsed);
}

function rows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function studentRows(value, studentId) {
  return rows(value).filter((row) => String(row?.studentId || row?.student_id || "") === String(studentId || ""));
}

function latest(items = [], max = 5) {
  return [...items]
    .sort((left, right) => String(right?.updatedAt || right?.createdAt || "").localeCompare(String(left?.updatedAt || left?.createdAt || "")))
    .slice(0, max);
}

export const AYLA_STEP1_PILOT = Object.freeze({
  planId: STEP1_PILOT_PLAN_ID,
  confirmation: STEP1_PILOT_CONFIRMATION,
  maxDays: STEP1_PILOT_MAX_DAYS,
  features: Object.freeze([
    "diagnostic",
    "roadmap",
    "personal_tutor",
    "assessments",
    "library",
    "qbank",
    "content_hub",
    "dynamic_notebook",
    "revision",
    "flashcards",
    "progress",
  ]),
});

export function buildAylaStep1PilotScenarios(today = new Date()) {
  const anchorDate = dateOnly(today);
  if (!anchorDate) throw new Error("A valid pilot anchor date is required");
  return [
    {
      key: "diagnostic_karachi",
      name: "Pilot Diagnostic Karachi",
      onboardingPath: "diagnostic_test",
      diagnosticProfile: "foundation_gap",
      examDate: addDays(anchorDate, 84),
      timezone: "Asia/Karachi",
      dailyHours: 3,
      weeklyStudyDays: 6,
      selectedWeakAreas: ["Cardiovascular", "Renal"],
      purpose: "Verified diagnostic with a known exam date and moderate daily capacity.",
    },
    {
      key: "diagnostic_new_york",
      name: "Pilot Diagnostic New York",
      onboardingPath: "diagnostic_test",
      diagnosticProfile: "mixed_readiness",
      examDate: addDays(anchorDate, 56),
      timezone: "America/New_York",
      dailyHours: 6,
      weeklyStudyDays: 6,
      selectedWeakAreas: ["Endocrine", "Neurology"],
      purpose: "A second verified diagnostic with a different result profile, timetable, and timezone.",
    },
    {
      key: "starting_fresh_no_clock",
      name: "Pilot Starting Fresh",
      onboardingPath: "starting_fresh",
      diagnosticProfile: null,
      examDate: "",
      timezone: "",
      dailyHours: 1,
      weeklyStudyDays: 5,
      qbankCompleted: 0,
      qbankAverage: 0,
      selectedWeakAreas: [],
      purpose: "Tests rolling discovery when both exam date and timezone are intentionally absent.",
    },
    {
      key: "qbank_half_london",
      name: "Pilot QBank Half Complete",
      onboardingPath: "quick_profile",
      diagnosticProfile: null,
      examDate: addDays(anchorDate, 70),
      timezone: "Europe/London",
      dailyHours: 4,
      weeklyStudyDays: 6,
      qbankCompleted: 50,
      qbankAverage: 55,
      selectedWeakAreas: ["Respiratory", "Gastrointestinal"],
      purpose: "Tests a student arriving halfway through a QBank with a provisional self-reported baseline.",
    },
    {
      key: "qbank_zero_dubai",
      name: "Pilot QBank Not Started",
      onboardingPath: "quick_profile",
      diagnosticProfile: null,
      examDate: "",
      timezone: "Asia/Dubai",
      dailyHours: 2,
      weeklyStudyDays: 5,
      qbankCompleted: 0,
      qbankAverage: 0,
      selectedWeakAreas: ["Biochemistry", "Immunology"],
      purpose: "Separates a zero-percent QBank profile from the explicit Starting Fresh path.",
    },
  ].map((scenario) => ({
    ...scenario,
    anchorDate,
    examDatePolicy: scenario.examDate ? "known" : "not_booked",
    timezonePolicy: scenario.timezone ? "confirmed" : "not_provided",
  }));
}

export function aylaPilotStudyDate(student = {}, fallback = new Date()) {
  const realDate = dateOnly(fallback);
  const pilot = student.pilotSimulation || student.pilot_simulation;
  if (student.pilotTest !== true && student.pilot_test !== true) {
    return { date: realDate, simulated: false, dayOffset: 0, anchorDate: realDate };
  }
  const anchorDate = dateOnly(pilot?.anchorDate || pilot?.anchor_date || student.createdAt || realDate) || realDate;
  const dayOffset = Math.max(0, Math.min(STEP1_PILOT_MAX_DAYS, Number(pilot?.dayOffset ?? pilot?.day_offset ?? 0) || 0));
  return {
    date: addDays(anchorDate, dayOffset),
    simulated: true,
    dayOffset,
    anchorDate,
  };
}

export function advanceAylaPilotStudyDate(student = {}, days = 1, fallback = new Date()) {
  if (student.pilotTest !== true && student.pilot_test !== true) {
    throw Object.assign(new Error("Only a private pilot student can use accelerated study time"), { statusCode: 409 });
  }
  const increment = Number(days);
  if (!Number.isInteger(increment) || increment < 1 || increment > STEP1_PILOT_MAX_DAYS) {
    throw Object.assign(new Error(`Pilot time can advance by 1–${STEP1_PILOT_MAX_DAYS} days`), { statusCode: 400 });
  }
  const current = aylaPilotStudyDate(student, fallback);
  const nextOffset = Math.min(STEP1_PILOT_MAX_DAYS, current.dayOffset + increment);
  return {
    ...student,
    pilotSimulation: {
      enabled: true,
      anchorDate: current.anchorDate,
      dayOffset: nextOffset,
      simulatedDate: addDays(current.anchorDate, nextOffset),
      maxAdvanceDays: STEP1_PILOT_MAX_DAYS,
    },
  };
}

export function buildAylaMateActivityFeed({
  student = {},
  date = "",
  systemProgress = [],
  plan = null,
  assignments = [],
  activityHistory = [],
  questionAttempts = [],
  flashcardReviews = [],
  assessmentAttempts = [],
  resources = [],
  revisionQueue = [],
} = {}) {
  const studentId = student.id || student.studentId || student.student_id;
  const feed = [];
  const add = (item) => {
    if (!item?.title || !item?.message) return;
    const identity = clean(item.id || `${item.type || "update"}-${feed.length + 1}`, 180);
    if (feed.some((row) => row.id === identity)) return;
    feed.push({ id: identity, type: item.type || "update", status: item.status || "delivered", ...item });
  };

  if (!clean(student.examDate || student.exam_date || student.targetDate || student.target_date)) {
    add({
      id: "rolling-plan-no-exam-date",
      type: "planning",
      title: "I am using a rolling discovery plan",
      message: "You have not entered an exam date, so I built a seven-day plan from your available hours and verified performance instead of inventing a deadline.",
      because: "Exam date is optional and no date is currently stored.",
      next: "After seven study days, I will ask again. Adding a date will let me calculate the full exam timeline.",
      route: "/dashboard/today",
    });
  }

  if (!clean(student.timezone)) {
    add({
      id: "timezone-needed",
      type: "setup",
      title: "Confirm your timezone for clock-based reminders",
      message: "Your date-based roadmap still works, but timed reminders are paused so I do not notify you at the wrong hour.",
      because: "No confirmed timezone is stored for this profile.",
      next: "Confirm a timezone in your profile when you want morning, evening, or deadline reminders.",
      route: "/dashboard/profile",
    });
  }

  for (const progress of latest(systemProgress.filter((row) => Number(row?.evidenceCount || 0) > 0), 3)) {
    const baseline = Number(progress.baselinePercent);
    const mastery = Number(progress.masteryPercent);
    const improvement = Number(progress.improvementPercent);
    if (!Number.isFinite(baseline) || !Number.isFinite(mastery)) continue;
    const system = clean(progress.system || "this system", 120);
    add({
      id: `mastery-${clean(progress.systemKey || system, 100)}-${mastery}`,
      type: improvement >= 0 ? "progress" : "weakness",
      title: improvement >= 0 ? `${system} is improving` : `${system} needs reinforcement`,
      message: `Your verified mastery moved from ${baseline}% to ${mastery}% (${improvement >= 0 ? "+" : ""}${Number.isFinite(improvement) ? improvement : mastery - baseline} points).`,
      because: `${Number(progress.evidenceCount || 0)} verified learning event${Number(progress.evidenceCount || 0) === 1 ? "" : "s"} contributed to this update.`,
      next: progress.trend === "improving"
        ? "I will keep the system in revision while gradually increasing mixed questions."
        : "I will prioritize targeted questions, linked recall cards, and a checkpoint before increasing load.",
      route: "/dashboard/progress",
      evidence: { system, evidenceCount: Number(progress.evidenceCount || 0), evidenceTypes: progress.evidenceTypes || [] },
    });
  }

  const privateCards = studentRows(resources, studentId).filter((row) =>
    row?.bucket === "weak_area"
    && (row?.verificationStatus === "server_verified_mistake" || row?.serverVerified === true));
  for (const attempt of latest(studentRows(questionAttempts, studentId).filter((row) => {
    if (row?.serverVerified !== true && row?.server_verified !== true) return false;
    if (row?.correct === false) return true;
    return String(row?.outcome || row?.result || "").toLowerCase() === "incorrect";
  }), 3)) {
    const linked = privateCards.find((card) => rows(card.sourceAttemptIds).map(String).includes(String(attempt.id)));
    const dueRevision = studentRows(revisionQueue, studentId).find((row) =>
      String(row.sourceAttemptId || row.source_attempt_id || "") === String(attempt.id)
      || String(row.resourceId || "") === String(linked?.id || ""));
    add({
      id: `question-miss-${attempt.id}`,
      type: "weakness",
      title: `${clean(attempt.system || "A weak area", 120)} was added to focused review`,
      message: linked
        ? `You missed ${clean(attempt.topic || "a verified question", 160)}, so I created or refreshed its private mistake flashcard${dueRevision ? " and added it to revision" : ""}.`
        : `You missed ${clean(attempt.topic || "a verified question", 160)}. I recorded the evidence, but no mistake card is marked as delivered yet.`,
      because: `Verified question attempt ${clean(attempt.id, 120)} was incorrect.`,
      next: linked ? "Review the linked recall card, then answer another question on the same concept." : "The roadmap will use this evidence without claiming an undelivered resource.",
      route: linked ? "/dashboard/flashcards" : "/dashboard/revision",
      status: linked ? "delivered" : "recorded",
      evidence: { attemptId: attempt.id, flashcardId: linked?.id || null, revisionId: dueRevision?.id || null },
    });
  }

  for (const review of latest(studentRows(flashcardReviews, studentId).filter((row) =>
    row?.serverVerified === true || row?.server_verified === true), 3)) {
    const rating = clean(review.rating || "reviewed", 30).toLowerCase();
    const topic = clean(review.topic || review.system || "a recall card", 160);
    const nextReviewDate = clean(review.nextReviewDate || review.next_review_date || "", 40);
    add({
      id: `flashcard-review-${review.id}`,
      type: "recall",
      title: `${topic} flashcard review completed`,
      message: `Your ${rating} review was saved${nextReviewDate ? ` and the next recall is scheduled for ${nextReviewDate}` : ""}.`,
      because: `Verified flashcard review ${clean(review.id, 120)} was stored after your response.`,
      next: ["again", "hard"].includes(rating)
        ? "This concept remains in focused revision so it can be tested again."
        : "AylaMe will return this card when its next review becomes due.",
      route: "/dashboard/flashcards",
      status: "delivered",
      evidence: {
        flashcardReviewId: review.id,
        resourceId: review.resourceId || review.resource_id || null,
        assignmentId: review.assignmentId || review.assignment_id || null,
        rating,
        nextReviewDate: nextReviewDate || null,
      },
    });
  }

  for (const attempt of latest(studentRows(assessmentAttempts, studentId).filter((row) => row?.serverVerified === true), 2)) {
    const linkedCount = rows(attempt.weakAreaFlashcardResourceIds).length;
    add({
      id: `assessment-${attempt.id}`,
      type: "assessment",
      title: "Your assessment changed the plan",
      message: `You scored ${Number(attempt.scorePercent ?? attempt.score ?? 0)}%. I linked ${linkedCount} weak-area flashcard${linkedCount === 1 ? "" : "s"} from verified misses.`,
      because: `Assessment ${clean(attempt.id, 120)} was submitted and verified.`,
      next: linkedCount
        ? "The next roadmap uses those weak concepts before adding broader work."
        : "No extra flashcard is claimed unless a verified incorrect answer produced one.",
      route: "/dashboard/assessments",
      evidence: { assessmentAttemptId: attempt.id, weakAreaFlashcardsLinked: linkedCount },
    });
  }

  const completed = assignments.filter((row) => String(row?.status || "").toLowerCase() === "completed").length;
  const pending = assignments.filter((row) => ["pending", "assigned", "in_progress"].includes(String(row?.status || "").toLowerCase())).length;
  if (plan) {
    add({
      id: `daily-plan-${date || plan.date || "today"}-${plan.version || 1}`,
      type: "roadmap",
      title: `Today’s roadmap is ready`,
      message: `${completed} task${completed === 1 ? "" : "s"} completed and ${pending} still active for ${clean(date || plan.date || "today", 40)}.`,
      because: clean(plan.reason || plan.rationale || "The plan uses your available time, weak-area evidence, due revision, and unfinished work.", 400),
      next: pending ? "Complete one task and I will use its verified history in the next adjustment." : "I will build the next day from what you actually completed.",
      route: "/dashboard/today",
      evidence: { planId: plan.id || null, planVersion: plan.version || 1, completed, pending },
    });
  }

  for (const event of latest(studentRows(activityHistory, studentId), 3)) {
    if (!["personal_tutor_recommendation_applied", "daily_plan_rebuilt"].includes(String(event.type || ""))) continue;
    add({
      id: `activity-${event.id}`,
      type: "adaptation",
      title: event.type === "personal_tutor_recommendation_applied" ? "I applied your roadmap adjustment" : "I rebuilt the future roadmap",
      message: "The update is saved. Completed history was preserved and only the current or future plan changed.",
      because: clean(event.payload?.reason || event.payload?.recommendationKind || "A recorded AylaMe planning action requested the change.", 360),
      next: "The new plan is visible in Today and Roadmap.",
      route: "/dashboard/today",
      evidence: { activityId: event.id, resultPlanId: event.payload?.resultPlanId || null },
    });
  }

  return feed.slice(0, 12);
}
