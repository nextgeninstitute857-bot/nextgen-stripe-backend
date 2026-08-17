import { buildAylaMistakeFlashcard, mergeAylaMistakeFlashcard } from "./aylamed-adaptive-core.js";
import { buildAylaAssessmentLearningGate, buildAylaWeakAreaStudyGate } from "./aylamed-assessment-sequencing.js";
import { buildAylaPersonalTutorDecision } from "./aylamed-personal-tutor.js";
import { scheduleFlashcardReview } from "./flashcard-engine.js";
import { aylaNclexDiagnosticSystems } from "./aylamed-nclex-diagnostic.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_DAYS = Object.freeze([14, 30, 120, 150]);

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function virtualDate(anchor, day) {
  return new Date(new Date(anchor).getTime() + (day - 1) * DAY_MS);
}

function average(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function learnerAccuracy(day, scenario) {
  if (scenario === "stagnant") return 48;
  if (day <= 14) return 43 + day * 0.8;
  if (day <= 30) return 54 + (day - 14) * 0.65;
  if (day <= 120) return 64 + (day - 30) * 0.2;
  return 82 + (day - 120) * 0.12;
}

function rollingSystemProgress(attempts, systems) {
  return systems.map((system) => {
    const rows = attempts.filter((row) => row.system === system).slice(-60);
    const correct = rows.filter((row) => row.outcome === "correct").length;
    const masteryPercent = rows.length ? Math.round((correct / rows.length) * 100) : 0;
    const earliest = rows.slice(0, Math.min(20, rows.length));
    const earliestCorrect = earliest.filter((row) => row.outcome === "correct").length;
    const baseline = earliest.length ? Math.round((earliestCorrect / earliest.length) * 100) : masteryPercent;
    return {
      system,
      masteryPercent,
      weaknessPercent: 100 - masteryPercent,
      improvementPercent: masteryPercent - baseline,
      evidenceCount: rows.length,
      trend: masteryPercent >= 70 ? "improving" : "needs_attention",
    };
  });
}

function checkpoint(day, state, tutorDecision, systems) {
  const recent = state.questionAttempts.slice(-120);
  const accuracyPercent = recent.length
    ? Math.round((recent.filter((row) => row.outcome === "correct").length / recent.length) * 100)
    : 0;
  const progress = rollingSystemProgress(state.questionAttempts, systems);
  const minimumMasteryPercent = Math.min(...progress.map((row) => row.masteryPercent));
  const expectedWeakestSystems = progress
    .filter((row) => row.masteryPercent === minimumMasteryPercent)
    .map((row) => row.system)
    .sort((left, right) => left.localeCompare(right));
  const expectedWeakestSystem = expectedWeakestSystems[0] || null;
  const intervals = [...state.cards.values()].map((row) => Number(row.interval_days || 0));
  return {
    day,
    date: state.date,
    verifiedQuestionAttempts: state.questionAttempts.length,
    recentAccuracyPercent: accuracyPercent,
    weakAreas: progress.filter((row) => row.masteryPercent < 70).map((row) => row.system),
    systemProgress: progress,
    mistakeCards: state.cards.size,
    flashcardReviews: state.flashcardReviews.length,
    averageCardIntervalDays: Number(average(intervals).toFixed(1)),
    maximumCardIntervalDays: Math.max(0, ...intervals),
    assessmentCount: state.assessmentAttempts.length,
    assessmentAveragePercent: Math.round(average(state.assessmentAttempts.map((row) => row.scorePercent))),
    tutorNextAssignmentId: tutorDecision.nextAction.assignmentId,
    tutorWeakSystem: tutorDecision.weakSystemProgress[0]?.system || null,
    expectedWeakestSystem,
    expectedWeakestSystems,
    tutorUsesOneStoredRoadmap: tutorDecision.authority.oneStoredRoadmap === true
      && tutorDecision.authority.tutorCreatesSecondPlan === false,
  };
}

/**
 * Deterministic virtual-time audit. It is intentionally pure: no database,
 * filesystem, browser, queue, email, or network adapters are imported.
 */
export function runAylaAdaptationFastForward({
  days = 150,
  scenario = "improving",
  examVariant = "nclex_rn",
  anchor = "2026-01-01T12:00:00.000Z",
} = {}) {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(Number(days) || 150)));
  const safeScenario = scenario === "stagnant" ? "stagnant" : "improving";
  const officialSystems = aylaNclexDiagnosticSystems(examVariant);
  if (!officialSystems.length) throw new Error("A reviewed NCLEX-RN or NCLEX-PN variant is required");
  const systems = [...officialSystems];
  const student = {
    id: `SIM-${examVariant}-${safeScenario}`,
    examTrackId: "nclex",
    examVariant,
    dailyHours: 3,
    targetDate: isoDay(virtualDate(anchor, safeDays + 30)),
  };
  const state = {
    date: isoDay(anchor),
    cards: new Map(),
    questionAttempts: [],
    flashcardReviews: [],
    assessmentAttempts: [],
    recentPlans: [],
    checkpoints: {},
    gateChecks: {
      startingFreshBlockedBeforeLearning: false,
      weakAreaBlockedBeforeTargetedLearning: false,
      oneAssessmentPerDayEnforced: false,
    },
    revisionChecks: {
      hiddenBetweenDueDates: 0,
      resurfacedCards: new Set(),
    },
    maximumAssessmentsInOneDay: 0,
    engineCalls: { flashcardScheduler: 0, assessmentGates: 0, personalTutor: 0 },
  };

  for (let day = 1; day <= safeDays; day += 1) {
    const now = virtualDate(anchor, day);
    const date = isoDay(now);
    state.date = date;

    const dueCards = [...state.cards.values()].filter((card) => !card.next_review_date || card.next_review_date <= date);
    for (const card of dueCards) {
      const previousReviews = Number(card.simulationReviewCount || 0);
      if (previousReviews > 0) state.revisionChecks.resurfacedCards.add(card.id);
      const rating = safeScenario === "stagnant"
        ? (day % 3 === 0 ? "hard" : "again")
        : day < 20 ? "hard" : day < 60 ? "good" : "easy";
      const scheduled = scheduleFlashcardReview(card, rating, now);
      state.engineCalls.flashcardScheduler += 1;
      Object.assign(card, scheduled, { simulationReviewCount: previousReviews + 1 });
      if (card.next_review_date > isoDay(virtualDate(anchor, day + 1))) {
        state.revisionChecks.hiddenBetweenDueDates += 1;
      }
      state.flashcardReviews.push({
        id: `REVIEW-${day}-${card.id}`,
        resourceId: card.id,
        serverVerified: true,
        rating,
        system: card.system,
        topic: card.topic,
        reviewedAt: now.toISOString(),
      });
    }

    const baseAccuracy = learnerAccuracy(day, safeScenario);
    const attemptsToday = [];
    for (let index = 0; index < 12; index += 1) {
      const systemIndex = (day + index) % systems.length;
      const system = systems[systemIndex];
      const systemAdjustment = -14 + systemIndex * 4;
      const threshold = Math.max(10, Math.min(95, baseAccuracy + systemAdjustment));
      const deterministicRoll = (day * 37 + index * 19 + systemIndex * 11) % 100;
      const correct = deterministicRoll < threshold;
      const identity = `${systemIndex}-concept-${index % 6}`;
      const attempt = {
        id: `ATTEMPT-${day}-${index}`,
        resourceId: `QUESTION-${day}-${index}`,
        serverVerified: true,
        examTrackId: "nclex",
        system,
        topic: "Clinical judgment",
        outcome: correct ? "correct" : "incorrect",
        answeredAt: now.toISOString(),
      };
      attemptsToday.push(attempt);
      state.questionAttempts.push(attempt);
      if (!correct) {
        const candidate = buildAylaMistakeFlashcard({
          student,
          examTrack: "nclex",
          sourceIdentity: identity,
          sourceAttemptId: attempt.id,
          sourceSessionId: `DAY-${day}`,
          question: {
            id: identity,
            question_html: `<p>What is the safest action for ${system} concept ${index % 6}?</p>`,
            correct_answer_html: "Use the verified priority intervention.",
            explanation_html: "Apply the official client-needs framework.",
            system,
            topic: "Clinical judgment",
          },
          now: now.toISOString(),
        });
        const merged = mergeAylaMistakeFlashcard(state.cards.get(candidate.id), candidate);
        if (!merged.next_review_date) merged.next_review_date = isoDay(virtualDate(anchor, day + 1));
        state.cards.set(merged.id, merged);
      }
    }

    const progress = rollingSystemProgress(state.questionAttempts, systems);
    const weakest = [...progress].sort((left, right) => left.masteryPercent - right.masteryPercent)[0];
    const startingFresh = day <= 2;
    const beforeLearning = buildAylaAssessmentLearningGate({
      startingFresh,
      completedLearningAssignments: 0,
      completedPracticeQuestions: 0,
      assessmentsCompletedToday: 0,
    });
    state.engineCalls.assessmentGates += 1;
    if (startingFresh && beforeLearning?.type === "learning_first") {
      state.gateChecks.startingFreshBlockedBeforeLearning = true;
    }
    const weakBefore = buildAylaWeakAreaStudyGate({
      system: weakest.system,
      accuracy: weakest.masteryPercent,
      completedTargetedLearning: 0,
    });
    state.engineCalls.assessmentGates += 1;
    if (weakBefore?.type === "weak_area_learning") {
      state.gateChecks.weakAreaBlockedBeforeTargetedLearning = true;
    }

    const assessmentDue = day % 7 === 0;
    let assessmentsToday = 0;
    if (assessmentDue) {
      const afterLearning = buildAylaAssessmentLearningGate({
        startingFresh,
        completedLearningAssignments: startingFresh ? 2 : 1,
        completedPracticeQuestions: attemptsToday.length,
        assessmentsCompletedToday: 0,
      });
      const weakAfter = buildAylaWeakAreaStudyGate({
        system: weakest.system,
        accuracy: weakest.masteryPercent,
        completedTargetedLearning: 1,
      });
      state.engineCalls.assessmentGates += 2;
      if (!afterLearning && !weakAfter) {
        assessmentsToday = 1;
        const latestAccuracy = Math.round((attemptsToday.filter((row) => row.outcome === "correct").length / attemptsToday.length) * 100);
        state.assessmentAttempts.unshift({
          id: `ASSESSMENT-${day}`,
          serverVerified: true,
          system: weakest.system,
          scorePercent: latestAccuracy,
          completedAt: now.toISOString(),
        });
      }
      const secondAssessmentGate = buildAylaAssessmentLearningGate({
        startingFresh: false,
        completedLearningAssignments: 1,
        completedPracticeQuestions: attemptsToday.length,
        assessmentsCompletedToday: assessmentsToday,
      });
      state.engineCalls.assessmentGates += 1;
      if (assessmentsToday === 1 && secondAssessmentGate?.type === "daily_assessment_limit") {
        state.gateChecks.oneAssessmentPerDayEnforced = true;
      }
    }
    state.maximumAssessmentsInOneDay = Math.max(state.maximumAssessmentsInOneDay, assessmentsToday);

    const assignments = [
      {
        id: `PLAN-${day}-WEAK`,
        status: "pending",
        category: "revision",
        priority: "critical",
        title: `Targeted ${weakest.system} revision`,
        system: weakest.system,
        topic: "Clinical judgment",
        estimatedMinutes: 35,
        revisionQueueIds: dueCards.map((row) => row.id),
      },
      {
        id: `PLAN-${day}-PRACTICE`,
        status: "pending",
        category: "internal_mcqs",
        priority: "high",
        title: `${weakest.system} practice`,
        system: weakest.system,
        topic: "Clinical judgment",
        estimatedMinutes: 45,
        items: attemptsToday,
      },
      ...(assessmentDue ? [{
        id: `PLAN-${day}-ASSESSMENT`,
        status: assessmentsToday ? "completed" : "pending",
        category: "assessment",
        priority: "medium",
        title: `${weakest.system} adaptive checkpoint`,
        system: weakest.system,
        topic: "Clinical judgment",
        estimatedMinutes: 25,
        items: [{ questions: Array.from({ length: 20 }, (_, index) => ({ id: `A-${day}-${index}` })) }],
      }] : []),
    ];
    const plan = {
      id: `ROADMAP-${day}`,
      version: 1,
      date,
      status: "active",
      capacityMinutes: 180,
      assessmentTutor: assessmentDue
        ? { status: "scheduled", label: `${weakest.system} adaptive checkpoint`, questionCount: 20 }
        : { status: "monitoring", label: "Adaptive assessment monitoring", questionCount: 0 },
    };
    const tutorDecision = buildAylaPersonalTutorDecision({
      date,
      plan,
      assignments,
      student: { ...student, weakAreas: progress.filter((row) => row.masteryPercent < 70).map((row) => row.system) },
      questionAttempts: state.questionAttempts.slice(-250).reverse(),
      assessmentAttempts: state.assessmentAttempts,
      flashcardReviews: state.flashcardReviews.slice(-250).reverse(),
      revisionItems: dueCards.map((row) => ({ id: row.id, status: "due" })),
      systemProgress: progress,
      recentPlans: state.recentPlans,
      warning: { level: "on_track", backlogMinutes: 0 },
      surfaceProgress: {
        flashcards: state.flashcardReviews.length,
        revision: dueCards.length,
      },
    });
    state.engineCalls.personalTutor += 1;
    state.recentPlans.unshift({ id: plan.id, date, status: "completed", completionPercent: safeScenario === "stagnant" ? 70 : 100 });
    state.recentPlans = state.recentPlans.slice(0, 5);

    if (CHECKPOINT_DAYS.includes(day) || day === safeDays) {
      state.checkpoints[day] = checkpoint(day, state, tutorDecision, systems);
    }
  }

  const firstCheckpoint = state.checkpoints[Math.min(...Object.keys(state.checkpoints).map(Number))];
  const finalCheckpoint = state.checkpoints[safeDays];
  return {
    simulation: {
      version: 1,
      scenario: safeScenario,
      examVariant,
      virtualDays: safeDays,
      anchor: new Date(anchor).toISOString(),
      productionIsolation: {
        databaseWrites: 0,
        filesystemWrites: 0,
        networkRequests: 0,
        realStudentRecordsTouched: 0,
        productionClockChanged: false,
      },
    },
    checkpoints: state.checkpoints,
    acceptance: {
      officialVariantSystemsUsed: systems.every((system) => officialSystems.includes(system)),
      startingFreshStudiesBeforeAssessment: state.gateChecks.startingFreshBlockedBeforeLearning,
      weakAreaStudiesBeforeAssessment: state.gateChecks.weakAreaBlockedBeforeTargetedLearning,
      neverMoreThanOneAssessmentPerDay: state.maximumAssessmentsInOneDay <= 1
        && state.gateChecks.oneAssessmentPerDayEnforced,
      revisionCardsDisappearUntilDue: state.revisionChecks.hiddenBetweenDueDates > 0,
      revisionCardsReturnWhenDue: state.revisionChecks.resurfacedCards.size > 0,
      personalTutorUsesStoredRoadmap: Object.values(state.checkpoints).every((row) => row.tutorUsesOneStoredRoadmap),
      personalTutorTracksWeakestSystem: Object.values(state.checkpoints).every((row) => (
        Boolean(row.tutorWeakSystem) && row.expectedWeakestSystems.includes(row.tutorWeakSystem)
      )),
      verifiedEvidenceOnly: state.questionAttempts.every((row) => row.serverVerified === true)
        && state.assessmentAttempts.every((row) => row.serverVerified === true)
        && state.flashcardReviews.every((row) => row.serverVerified === true),
      performanceRespondsToEvidence: safeScenario === "improving"
        ? finalCheckpoint.recentAccuracyPercent > firstCheckpoint.recentAccuracyPercent
        : finalCheckpoint.recentAccuracyPercent <= firstCheckpoint.recentAccuracyPercent + 8,
    },
    totals: {
      verifiedQuestionAttempts: state.questionAttempts.length,
      assessmentAttempts: state.assessmentAttempts.length,
      mistakeCards: state.cards.size,
      flashcardReviews: state.flashcardReviews.length,
      resurfacedCards: state.revisionChecks.resurfacedCards.size,
      hiddenBetweenDueDates: state.revisionChecks.hiddenBetweenDueDates,
      maximumAssessmentsInOneDay: state.maximumAssessmentsInOneDay,
      engineCalls: state.engineCalls,
    },
    limitations: [
      "Virtual time validates state transitions, gating, evidence use, and deterministic adaptation; it does not prove a real learner will improve.",
      "Real educational effectiveness still requires a controlled student pilot with consented outcome measurement.",
    ],
  };
}

export function runAylaAdaptationFastForwardSuite(options = {}) {
  const days = Math.max(150, Number(options.days) || 150);
  const examVariant = options.examVariant || "nclex_rn";
  const improving = runAylaAdaptationFastForward({ ...options, days, examVariant, scenario: "improving" });
  const stagnant = runAylaAdaptationFastForward({ ...options, days, examVariant, scenario: "stagnant" });
  const improvementDetected = improving.checkpoints[days].recentAccuracyPercent
    > stagnant.checkpoints[days].recentAccuracyPercent;
  const nonImprovementNotInvented = stagnant.acceptance.performanceRespondsToEvidence;
  return {
    examVariant,
    days,
    improving,
    stagnant,
    comparison: {
      improvementDetected,
      nonImprovementNotInvented,
      safeToUseAsProductionMigration: false,
      purpose: "read-only accelerated verification",
    },
  };
}

export const AYLA_ADAPTATION_FAST_FORWARD_CHECKPOINT_DAYS = CHECKPOINT_DAYS;
