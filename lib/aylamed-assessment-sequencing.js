function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function buildAylaAssessmentLearningGate(input = {}) {
  const startingFresh = input.startingFresh === true;
  const completedLearningAssignments = count(input.completedLearningAssignments);
  const completedPracticeQuestions = count(input.completedPracticeQuestions);
  const assessmentsCompletedToday = count(input.assessmentsCompletedToday);
  const requiredLearningAssignments = startingFresh ? 2 : 1;
  const requiredPracticeQuestions = startingFresh ? 10 : 5;

  if (assessmentsCompletedToday > 0) {
    return {
      status: "study_first",
      type: "daily_assessment_limit",
      label: "Assessment complete — study next",
      reason: "A scored assessment is already complete today. AylaMed will use that result for learning and revision before scheduling another scored checkpoint.",
      trigger: "one_scored_assessment_per_study_day",
      prerequisites: {
        assessmentsCompletedToday,
        nextStep: "Complete the learning and revision assigned from today’s result.",
      },
    };
  }

  if (completedLearningAssignments >= requiredLearningAssignments || completedPracticeQuestions >= requiredPracticeQuestions) return null;

  return {
    status: "study_first",
    type: "learning_first",
    label: startingFresh ? "Learn first — no assessment yet" : "Complete learning before the next checkpoint",
    reason: startingFresh
      ? "You chose Starting Fresh. AylaMed is beginning with a guided learning sequence and will not overload you with a scored assessment before enough study evidence exists."
      : "AylaMed needs completed learning or practice evidence before another scored assessment is useful.",
    trigger: "learning_readiness_gate",
    prerequisites: {
      startingFresh,
      completedLearningAssignments,
      requiredLearningAssignments,
      completedPracticeQuestions,
      requiredPracticeQuestions,
      nextStep: startingFresh
        ? `Complete ${requiredLearningAssignments} guided learning tasks or ${requiredPracticeQuestions} practice questions.`
        : `Complete a guided learning task or ${requiredPracticeQuestions} practice questions.`,
    },
  };
}

export function buildAylaWeakAreaStudyGate(input = {}) {
  const completedTargetedLearning = count(input.completedTargetedLearning);
  if (!input.system || completedTargetedLearning > 0) return null;
  const system = String(input.system);
  const accuracy = Math.max(0, Math.min(100, count(input.accuracy)));
  return {
    status: "study_first",
    type: "weak_area_learning",
    label: `Study ${system} before the checkpoint`,
    reason: `${system} is currently weak (${accuracy}% recent question accuracy). AylaMed will assign targeted learning and revision first, then test whether the weakness improved.`,
    trigger: "weak_area_study_before_assessment",
    system,
    prerequisites: {
      weakArea: system,
      completedTargetedLearning,
      requiredTargetedLearning: 1,
      nextStep: `Complete the next ${system} learning or revision task.`,
    },
  };
}

