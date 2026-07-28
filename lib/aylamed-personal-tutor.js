import crypto from "node:crypto";
import { buildAylaNbmeReadinessSnapshot } from "./aylamed-nbme-center.js";

export const AYLA_PERSONAL_TUTOR_ENGINE = "ayla_adaptive_roadmap_v189";

const ACTIVE_ASSIGNMENT_STATUSES = new Set(["pending", "in_progress", "review_again"]);
const QUESTION_CATEGORIES = new Set(["external_questions", "internal_mcqs", "assessment"]);
const PLAN_INTENT = /\b(what (?:do|should) i (?:do|study)|what(?:'s| is) next|next (?:task|step|assignment)|today(?:'s)? plan|study plan|my plan|(?:make|build|change|adjust|rebalance) (?:me )?(?:my )?(?:study )?plan|roadmap|schedule|overload(?:ed)?|overwhelm(?:ed)?|too much|reduce (?:my )?questions?|increase (?:my )?questions?|more questions?|fewer questions?|move (?:my )?(?:unfinished|pending|overdue)|unfinished work|missed work|personal assessment|self assessment|nbme|readiness (?:check|form)|checkpoint|notebook (?:entry|note|review)|weak (?:area|topic|system)|should i (?:read|watch|practi[cs]e|revise)|read,? watch|practi[cs]e|revise)\b/i;

function cleanText(value, limit = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function numberBetween(value, min, max, fallback = min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function dateOnly(value) {
  const clean = cleanText(value, 40);
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : "";
}

function key(value) {
  return cleanText(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stableId(...parts) {
  const digest = crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex").slice(0, 16);
  return `AYLA-TUTOR-${digest}`;
}

function actionTarget(kind = "roadmap", input = {}) {
  const assignmentId = cleanText(input.assignmentId, 160);
  const notebookId = cleanText(input.notebookId, 160);
  const attemptId = cleanText(input.attemptId, 160);
  if (kind === "roadmap_assignment" && assignmentId) {
    return {
      kind,
      route: "/dashboard/roadmap",
      query: { assignment: assignmentId },
      appRoute: `/dashboard/roadmap?assignment=${encodeURIComponent(assignmentId)}`,
      assignmentId,
    };
  }
  if (kind === "assessment") {
    const suffix = assignmentId ? `?assignment=${encodeURIComponent(assignmentId)}` : "";
    return {
      kind,
      route: "/dashboard/assessments",
      query: assignmentId ? { assignment: assignmentId } : {},
      appRoute: `/dashboard/assessments${suffix}`,
      assignmentId: assignmentId || null,
    };
  }
  if (kind === "notebook" && notebookId) {
    return {
      kind,
      route: `/dashboard/notebook/${encodeURIComponent(notebookId)}`,
      query: {},
      appRoute: `/dashboard/notebook/${encodeURIComponent(notebookId)}`,
      notebookId,
    };
  }
  if (kind === "nbme") {
    const route = attemptId
      ? `/dashboard/nbme/attempt/${encodeURIComponent(attemptId)}`
      : "/dashboard/nbme";
    return {
      kind,
      route,
      query: {},
      appRoute: route,
      attemptId: attemptId || null,
    };
  }
  return {
    kind: "roadmap",
    route: "/dashboard/roadmap",
    query: {},
    appRoute: "/dashboard/roadmap",
  };
}

function safePlanIdentity(plan = {}, date = "") {
  return {
    id: cleanText(plan.id, 160) || null,
    version: Math.max(0, Math.floor(numberBetween(plan.version, 0, 1000000, 0))),
    date: dateOnly(plan.date) || dateOnly(date) || null,
    status: cleanText(plan.status || "active", 40).toLowerCase(),
  };
}

function activeAssignments(assignments = []) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter((row) => row && ACTIVE_ASSIGNMENT_STATUSES.has(String(row.status || "pending").toLowerCase()));
}

function assignmentQuestionCount(assignment = {}) {
  if (!QUESTION_CATEGORIES.has(String(assignment.category || assignment.type || "").toLowerCase())) return 0;
  const items = Array.isArray(assignment.items) ? assignment.items : [];
  if (String(assignment.category || "").toLowerCase() === "assessment") {
    const questions = items.flatMap((item) => Array.isArray(item?.questions) ? item.questions : []);
    if (questions.length) return questions.length;
  }
  return Math.max(items.length, Array.isArray(assignment.resourceIds) ? assignment.resourceIds.length : 0, 1);
}

function average(values = []) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function recentPlanSignals(recentPlans = [], currentDate = "") {
  const rows = (Array.isArray(recentPlans) ? recentPlans : [])
    .filter((row) => !currentDate || !row.date || String(row.date) < String(currentDate))
    .filter((row) => !["cancelled", "superseded"].includes(String(row.status || "").toLowerCase()))
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
    .slice(0, 5);
  const completion = rows.map((row) => numberBetween(row.completionPercent ?? row.completion_percent, 0, 100, 0));
  return {
    observedDays: rows.length,
    averageCompletionPercent: completion.length ? Math.round(average(completion)) : null,
    lowCompletionDays: completion.filter((value) => value < 50).length,
    strongCompletionDays: completion.filter((value) => value >= 85).length,
  };
}

function verifiedQuestionSignals(questionAttempts = []) {
  const candidates = (Array.isArray(questionAttempts) ? questionAttempts : [])
    .filter((row) => row?.serverVerified === true)
    .filter((row) => ["correct", "incorrect", "guessed", "review_again"].includes(String(row.outcome || row.result || "").toLowerCase()))
    .slice(0, 250);
  const seenResources = new Set();
  const rows = candidates.filter((row) => {
    const resourceId = cleanText(row.resourceId || row.resource_id || row.contentQuestionId || row.content_question_id, 300);
    if (!resourceId) return true;
    if (seenResources.has(resourceId)) return false;
    seenResources.add(resourceId);
    return true;
  });
  const correct = rows.filter((row) => String(row.outcome || row.result || "").toLowerCase() === "correct").length;
  return {
    rows,
    count: rows.length,
    correct,
    accuracyPercent: rows.length ? Math.round((correct / rows.length) * 100) : null,
  };
}

function assessmentSignals(attempts = []) {
  const scores = (Array.isArray(attempts) ? attempts : [])
    .filter((row) => row && row.serverVerified === true)
    .map((row) => Number(row.scorePercent ?? row.score_percent ?? row.score))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    .slice(0, 20);
  return {
    count: scores.length,
    averagePercent: scores.length ? Math.round(average(scores)) : null,
    latestPercent: scores.length ? Math.round(scores[0]) : null,
  };
}

function crossSystemWeakPattern({ questionAttempts = [], flashcardReviews = [], conceptMastery = [] } = {}) {
  const groups = new Map();
  const add = (topic, system, weight, signal) => {
    const topicKey = key(topic);
    const cleanSystem = cleanText(system || "General", 120) || "General";
    if (!topicKey || topicKey.length < 3 || !cleanSystem || cleanSystem.toLowerCase() === "general") return;
    if (!groups.has(topicKey)) groups.set(topicKey, { topic: cleanText(topic, 180), systems: new Set(), signals: new Set(), score: 0, evidenceCount: 0 });
    const row = groups.get(topicKey);
    row.systems.add(cleanSystem);
    row.signals.add(signal);
    row.score += weight;
    row.evidenceCount += 1;
  };

  for (const row of verifiedQuestionSignals(questionAttempts).rows) {
    const outcome = String(row.outcome || row.result || "").toLowerCase();
    if (["incorrect", "review_again", "guessed"].includes(outcome)) add(row.topic, row.system, outcome === "incorrect" ? 3 : 2, "question_performance");
  }
  const seenCards = new Set();
  for (const row of Array.isArray(flashcardReviews) ? flashcardReviews : []) {
    if (row?.serverVerified !== true) continue;
    const resourceId = cleanText(row.resourceId || row.resource_id, 300);
    if (resourceId && seenCards.has(resourceId)) continue;
    if (resourceId) seenCards.add(resourceId);
    const rating = String(row?.rating || "").toLowerCase();
    if (["again", "hard"].includes(rating)) add(row.topic, row.system, rating === "again" ? 2 : 1.5, "difficult_recall");
  }
  for (const row of Array.isArray(conceptMastery) ? conceptMastery : []) {
    const mastery = Number(row?.masteryPercent ?? row?.mastery_percent);
    if (Number.isFinite(mastery) && mastery < 65) add(row.topic, row.system, Math.max(1, (65 - mastery) / 10), "concept_mastery");
  }

  return [...groups.values()]
    .filter((row) => row.systems.size >= 2 && row.evidenceCount >= 2)
    .map((row) => ({
      topic: row.topic,
      systems: [...row.systems].sort().slice(0, 8),
      evidenceCount: row.evidenceCount,
      evidenceTypes: [...row.signals].sort(),
      score: Number(row.score.toFixed(1)),
    }))
    .sort((left, right) => right.systems.length - left.systems.length || right.score - left.score || left.topic.localeCompare(right.topic))[0] || null;
}

function modalityForAssignment(assignment = {}) {
  const category = String(assignment.category || assignment.type || "").toLowerCase();
  if (assignment.revisionSourceType || (Array.isArray(assignment.revisionQueueIds) && assignment.revisionQueueIds.length)) return "revise";
  if (category === "reading") return "read";
  if (category === "video") return "watch";
  if (["external_questions", "internal_mcqs"].includes(category)) return "practise";
  if (category === "assessment") return "assess";
  if (category === "flashcards") return "revise";
  return "study";
}

function nextAssignment(assignments = []) {
  const priority = { critical: 40, high: 25, medium: 15, low: 5 };
  return activeAssignments(assignments)
    .map((row, index) => {
      const status = String(row.status || "pending").toLowerCase();
      const category = String(row.category || row.type || "").toLowerCase();
      const isRevision = Boolean(row.revisionSourceType || (Array.isArray(row.revisionQueueIds) && row.revisionQueueIds.length));
      const isCarried = Array.isArray(row.linkedAssignmentIds) && row.linkedAssignmentIds.length > 0;
      const score = (status === "in_progress" ? 100 : 0) + (priority[String(row.priority || "").toLowerCase()] || 0) + (isRevision ? 55 : 0) + (isCarried ? 45 : 0) + (category === "assessment" ? 12 : 0) - index / 100;
      return { row, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.row || null;
}

function safeNextAction(assignment, planIdentity) {
  if (!assignment) {
    return {
      state: "awaiting_verified_work",
      modality: "review",
      assignmentId: null,
      title: "No verified assignment is ready yet",
      reason: "The roadmap has no current verified assignment. The tutor will not invent a resource or reference.",
      returnLink: "/roadmap",
      actionTarget: actionTarget("roadmap"),
    };
  }
  const modality = modalityForAssignment(assignment);
  const reasons = [];
  if (String(assignment.status || "").toLowerCase() === "in_progress") reasons.push("Resume the work already in progress");
  if (Array.isArray(assignment.revisionQueueIds) && assignment.revisionQueueIds.length) reasons.push("This revision is due from permanent learning history");
  if (Array.isArray(assignment.linkedAssignmentIds) && assignment.linkedAssignmentIds.length) reasons.push("This unfinished work was carried into the authoritative plan");
  if (!reasons.length) reasons.push("This is the highest-priority unfinished item in the current roadmap");
  return {
    state: "ready",
    modality,
    assignmentId: cleanText(assignment.id, 160),
    category: cleanText(assignment.category || assignment.type, 80).toLowerCase(),
    title: cleanText(assignment.title || `${modality} next`, 320),
    system: cleanText(assignment.system || "General", 120),
    topic: cleanText(assignment.topic, 220),
    estimatedMinutes: Math.max(1, Math.round(numberBetween(assignment.estimatedMinutes, 1, 960, 15))),
    reason: reasons.join("; "),
    returnLink: `/roadmap/assignments/${encodeURIComponent(String(assignment.id || ""))}`,
    actionTarget: actionTarget("roadmap_assignment", { assignmentId: assignment.id }),
    planId: planIdentity.id,
  };
}

function notebookRecommendation(notebooks = [], focus = {}) {
  const focusSystem = key(focus.system);
  const focusTopic = key(focus.topic);
  const candidates = (Array.isArray(notebooks) ? notebooks : [])
    .filter((row) => row && !row.archivedAt && !row.deletedAt)
    .map((row) => {
      const studentBlocks = (Array.isArray(row.blocks) ? row.blocks : [])
        .filter((block) => block && block.contentOrigin !== "approved_source" && ["heading", "numbered_point", "text", "quote"].includes(String(block.type || "")) && cleanText(block.text));
      const latest = studentBlocks.slice().sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0];
      const rowSystem = key(row.system);
      const rowTopic = key(row.topic);
      const match = (focusTopic && rowTopic === focusTopic ? 80 : 0) + (focusSystem && rowSystem === focusSystem ? 45 : 0);
      return { row, latest, match };
    })
    .filter((entry) => entry.latest)
    .sort((left, right) => right.match - left.match || String(right.row.updatedAt || "").localeCompare(String(left.row.updatedAt || "")));
  const selected = candidates[0];
  if (!selected) return null;
  return {
    notebookId: cleanText(selected.row.id, 160),
    title: cleanText(selected.row.title || "Notebook entry", 240),
    system: cleanText(selected.row.system || "General", 120),
    topic: cleanText(selected.row.topic, 220),
    studentNotePreview: cleanText(selected.latest.text, 240),
    reason: selected.match > 0 ? "This student-authored note matches the roadmap’s current weak focus." : "This is the most recent student-authored notebook concept available for review.",
    returnLink: `/dynamic-notebook/${encodeURIComponent(String(selected.row.id || ""))}`,
    actionTarget: actionTarget("notebook", { notebookId: selected.row.id }),
  };
}

function assessmentRecommendation(plan = {}, assignments = []) {
  const tutor = plan.assessmentTutor && typeof plan.assessmentTutor === "object" ? plan.assessmentTutor : {};
  const activeAssessment = activeAssignments(assignments).find((row) => String(row.category || row.type || "").toLowerCase() === "assessment") || null;
  if (activeAssessment) {
    return {
      state: "scheduled_in_current_plan",
      assignmentId: cleanText(activeAssessment.id, 160),
      type: cleanText(activeAssessment.assessmentType || tutor.type || "adaptive", 80),
      label: cleanText(activeAssessment.title || tutor.label || "Adaptive assessment", 260),
      questionCount: assignmentQuestionCount(activeAssessment),
      reason: cleanText(activeAssessment.tutorReason || tutor.reason || "The single roadmap scheduled this checkpoint from verified progress.", 700),
      returnLink: `/roadmap/assignments/${encodeURIComponent(String(activeAssessment.id || ""))}`,
      actionTarget: actionTarget("assessment", { assignmentId: activeAssessment.id }),
    };
  }
  const state = cleanText(tutor.status || "monitoring", 80).toLowerCase();
  return {
    state,
    assignmentId: null,
    type: cleanText(tutor.type || "not_due", 80),
    label: cleanText(tutor.label || "Adaptive assessment monitoring", 260),
    questionCount: Math.max(0, Math.round(numberBetween(tutor.questionCount, 0, 200, 0))),
    reason: cleanText(tutor.reason || "The roadmap is monitoring verified progress before scheduling another assessment.", 700),
    returnLink: "/assessments",
    actionTarget: actionTarget("assessment"),
  };
}

function successStoryGuidance(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.advisory_only === true && row.personal_data_included === false && row.outcome_promised === false)
    .slice(0, 3)
    .map((row) => ({
      strategyId: cleanText(row.strategy_id, 160),
      patternLabel: cleanText(row.pattern_label || "Approved strategy pattern", 180),
      examTrackId: cleanText(row.exam_track_id, 120),
      challengeTags: (Array.isArray(row.challenge_tags) ? row.challenge_tags : []).map((tag) => cleanText(tag, 100)).filter(Boolean).slice(0, 12),
      strategyTags: (Array.isArray(row.strategy_tags) ? row.strategy_tags : []).map((tag) => cleanText(tag, 100)).filter(Boolean).slice(0, 12),
      strategySteps: (Array.isArray(row.strategy_steps) ? row.strategy_steps : []).slice(0, 5).map((step) => ({
        id: cleanText(step?.id, 120),
        action: cleanText(step?.action, 500),
        whyItHelped: cleanText(step?.why_it_helped, 700) || null,
        useWhen: cleanText(step?.use_when, 500) || null,
        caution: cleanText(step?.caution, 500) || null,
      })).filter((step) => step.action),
      applicabilityNotes: cleanText(row.applicability_notes, 900) || null,
      limitations: cleanText(row.limitations, 900) || null,
      evidenceBasis: cleanText(row.evidence_basis, 100),
      approvalVersion: Math.max(1, Math.floor(numberBetween(row.approval_version, 1, 1000000, 1))),
      source: "CRM AI Training Center — approved anonymized success story",
      advisoryOnly: true,
      outcomeIncluded: false,
      outcomePromised: false,
    }))
    .filter((row) => row.strategyId && row.strategySteps.length);
}

function workloadDecision({ warning = {}, plan = {}, assignments = [], recentPlans = [], questionSignals = {}, assessment = {}, student = {}, revisionItems = [] } = {}) {
  const capacity = numberBetween(plan.capacityMinutes, 1, 960, numberBetween(student.dailyHours, 1, 16, 3) * 60);
  const planned = activeAssignments(assignments).reduce((sum, row) => sum + numberBetween(row.estimatedMinutes, 0, 960, 0), 0) || numberBetween(plan.plannedMinutes, 0, 5000, 0);
  const backlogMinutes = numberBetween(warning.backlogMinutes, 0, 100000, 0);
  const recent = recentPlanSignals(recentPlans, plan.date);
  const planLoadRatio = capacity ? planned / capacity : 0;
  const backlogRatio = capacity ? backlogMinutes / capacity : 0;
  const dueRevisionCount = (Array.isArray(revisionItems) ? revisionItems : []).filter((row) => ["due", "assigned"].includes(String(row?.status || "due").toLowerCase())).length;
  const overloaded = String(warning.level || "").toLowerCase() === "high"
    || backlogRatio >= 1
    || planLoadRatio > 1.12
    || (recent.observedDays >= 3 && recent.lowCompletionDays >= 3);
  const underloaded = !overloaded
    && String(warning.level || "on_track").toLowerCase() === "on_track"
    && backlogMinutes === 0
    && dueRevisionCount === 0
    && recent.observedDays >= 3
    && recent.strongCompletionDays >= 3
    && (questionSignals.accuracyPercent === null || questionSignals.accuracyPercent >= 75)
    && (assessment.latestPercent === null || assessment.latestPercent >= 70)
    && planLoadRatio < 0.9;
  const state = overloaded ? "overloaded" : underloaded ? "ready_for_more" : "balanced";
  const adjustment = overloaded ? "reduce" : underloaded ? "intensive" : "standard";
  const questionVolumeAdjustment = adjustment;
  const assignedQuestionCount = activeAssignments(assignments).reduce((sum, row) => sum + assignmentQuestionCount(row), 0);
  const baselineQuestions = assignedQuestionCount || Math.max(5, Math.min(60, Math.round(numberBetween(student.dailyHours, 1, 16, 3) * 8)));
  const factor = adjustment === "reduce" ? 0.65 : adjustment === "intensive" ? 1.2 : 1;
  const recommendedQuestionCount = Math.max(5, Math.min(80, Math.round(baselineQuestions * factor)));
  const reasons = [];
  if (String(warning.level || "").toLowerCase() === "high") reasons.push("the roadmap workload warning is high");
  if (backlogRatio >= 1) reasons.push("overdue work is at least one full study day");
  if (planLoadRatio > 1.12) reasons.push("active work exceeds declared daily capacity");
  if (recent.observedDays >= 3 && recent.lowCompletionDays >= 3) reasons.push("three recent study days were below 50% completion");
  if (underloaded) reasons.push("recent completion is consistently strong with no due backlog");
  if (!reasons.length) reasons.push("current workload, completion, and verified performance are balanced");
  return {
    state,
    workloadAdjustment: adjustment,
    questionVolumeAdjustment,
    capacityMinutes: Math.round(capacity),
    activePlannedMinutes: Math.round(planned),
    planLoadPercent: Math.round(planLoadRatio * 100),
    backlogMinutes: Math.round(backlogMinutes),
    dueRevisionCount,
    assignedQuestionCount,
    recommendedQuestionCount,
    recentCompletion: recent,
    reason: cleanText(reasons.join("; "), 800),
  };
}

function unfinishedDecision(assignments = [], workload = {}) {
  const rows = activeAssignments(assignments).filter((row) => Array.isArray(row.linkedAssignmentIds) && row.linkedAssignmentIds.length);
  const minutes = rows.reduce((sum, row) => sum + numberBetween(row.estimatedMinutes, 0, 960, 0), 0);
  if (!rows.length) return { count: 0, minutes: 0, decision: "none_due", reason: "No unfinished work is currently carried into this plan." };
  if (workload.state === "overloaded") {
    return {
      count: rows.length,
      minutes: Math.round(minutes),
      decision: "keep_critical_and_move_lower_priority",
      reason: "Keep critical carried work in the authoritative plan and move only lower-priority unfinished work to the next study day during a version-checked rebuild.",
    };
  }
  return {
    count: rows.length,
    minutes: Math.round(minutes),
    decision: "complete_before_new_content",
    reason: "The roadmap has already carried this unfinished work forward and prioritizes it before new content.",
  };
}

function recommendation({
  planIdentity,
  kind,
  title,
  reason,
  planChange = false,
  directive = null,
  returnLink = null,
  target = null,
}) {
  const safeTarget = target && typeof target === "object" ? target : actionTarget("roadmap");
  return {
    id: stableId(AYLA_PERSONAL_TUTOR_ENGINE, planIdentity.id, planIdentity.version, planIdentity.date, kind, JSON.stringify(directive || {})),
    kind,
    title: cleanText(title, 260),
    reason: cleanText(reason, 800),
    planChange,
    action: planChange ? "rebuild_single_roadmap" : "open_current_roadmap_item",
    directive: planChange ? directive : null,
    returnLink: returnLink || "/roadmap",
    actionTarget: safeTarget,
    appRoute: safeTarget.appRoute,
  };
}

export function isAylaPersonalTutorPlanningIntent(value = "") {
  return PLAN_INTENT.test(cleanText(value, 4000));
}

export function buildAylaPersonalTutorDecision(input = {}) {
  const date = dateOnly(input.date) || dateOnly(input.plan?.date);
  const plan = input.plan && typeof input.plan === "object" ? input.plan : {};
  const assignments = Array.isArray(input.assignments) ? input.assignments : [];
  const student = input.student && typeof input.student === "object" ? input.student : {};
  const planIdentity = safePlanIdentity(plan, date);
  const questionSignals = verifiedQuestionSignals(input.questionAttempts);
  const assessments = assessmentSignals(input.assessmentAttempts);
  const weakPattern = crossSystemWeakPattern({
    questionAttempts: input.questionAttempts,
    flashcardReviews: input.flashcardReviews,
    conceptMastery: input.conceptMastery,
  });
  const workload = workloadDecision({
    warning: input.warning,
    plan,
    assignments,
    recentPlans: input.recentPlans,
    questionSignals,
    assessment: assessments,
    student,
    revisionItems: input.revisionItems,
  });
  const nextAction = safeNextAction(nextAssignment(assignments), planIdentity);
  const focus = weakPattern || { system: nextAction.system || plan.focusSystem || plan.systemFocus, topic: nextAction.topic || plan.focusTopic || plan.topicFocus };
  const notebook = notebookRecommendation(input.notebooks, focus);
  const assessment = assessmentRecommendation(plan, assignments);
  const nbmeReadiness = buildAylaNbmeReadinessSnapshot({
    student,
    attempts: input.nbmeAttempts,
    forms: input.nbmeForms,
    warning: input.warning,
    date,
  });
  const unfinishedWork = unfinishedDecision(assignments, workload);
  const approvedStoryGuidance = successStoryGuidance(input.successStoryStrategies);
  const recommendations = [];
  const planAllowsChanges = !["completed", "cancelled", "superseded"].includes(planIdentity.status);

  if (nextAction.assignmentId) {
    recommendations.push(recommendation({
      planIdentity,
      kind: "continue_next_assignment",
      title: `${nextAction.modality[0].toUpperCase()}${nextAction.modality.slice(1)} next: ${nextAction.title}`,
      reason: nextAction.reason,
      returnLink: nextAction.returnLink,
      target: nextAction.actionTarget,
    }));
  }
  if (planAllowsChanges && workload.workloadAdjustment !== "standard") {
    recommendations.push(recommendation({
      planIdentity,
      kind: workload.workloadAdjustment === "reduce" ? "reduce_workload" : "increase_question_volume",
      title: workload.workloadAdjustment === "reduce" ? "Rebalance today to reduce overload" : "Increase question volume carefully",
      reason: workload.reason,
      planChange: true,
      directive: {
        workloadAdjustment: workload.workloadAdjustment,
        questionVolumeAdjustment: workload.questionVolumeAdjustment,
        includeAssessment: false,
      },
    }));
  }
  if (planAllowsChanges && ["due", "deferred_capacity"].includes(assessment.state) && !assessment.assignmentId) {
    recommendations.push(recommendation({
      planIdentity,
      kind: "schedule_personal_assessment",
      title: assessment.label,
      reason: assessment.reason,
      planChange: true,
      directive: {
        workloadAdjustment: workload.workloadAdjustment === "intensive" ? "standard" : workload.workloadAdjustment,
        questionVolumeAdjustment: workload.questionVolumeAdjustment,
        includeAssessment: true,
      },
      returnLink: "/assessments",
      target: actionTarget("assessment"),
    }));
  }
  if (nbmeReadiness.recommendation
    && nbmeReadiness.recommendation.state !== "no_full_form_available") {
    recommendations.push(recommendation({
      planIdentity,
      kind: "self_assessment_readiness",
      title: nbmeReadiness.recommendation.title,
      reason: nbmeReadiness.recommendation.reason,
      returnLink: "/nbme",
      target: actionTarget("nbme", {
        attemptId: nbmeReadiness.recommendation.attempt_id || "",
      }),
    }));
  }
  if (notebook) {
    recommendations.push(recommendation({
      planIdentity,
      kind: "review_notebook_entry",
      title: `Review notebook: ${notebook.title}`,
      reason: notebook.reason,
      returnLink: notebook.returnLink,
      target: notebook.actionTarget,
    }));
  }
  if (approvedStoryGuidance[0]) {
    const strategy = approvedStoryGuidance[0];
    const firstStep = strategy.strategySteps[0];
    recommendations.push(recommendation({
      planIdentity,
      kind: "adapt_approved_success_strategy",
      title: `Consider this study tactic: ${firstStep.action}`,
      reason: `An approved anonymized success story used this tactic in a similar context. Adapt it to your current assignment; it is advisory evidence, not a promised or copied outcome.${strategy.limitations ? ` Limitation: ${strategy.limitations}` : ""}`,
      returnLink: nextAction.returnLink || "/roadmap",
      target: nextAction.actionTarget || actionTarget("roadmap"),
    }));
  }

  return {
    engine: AYLA_PERSONAL_TUTOR_ENGINE,
    authority: {
      oneStoredRoadmap: true,
      tutorCreatesSecondPlan: false,
      completedHistoryPreserved: true,
      verifiedResourcesOnly: true,
      successStoriesAdvisoryOnly: true,
      successStoryOutcomesNeverCopied: true,
    },
    generatedFromPlan: planIdentity,
    studentContext: {
      examTrackId: cleanText(student.examTrackId || student.exam_track_id || student.exam, 120),
      targetDate: dateOnly(student.targetDate || student.examDate || student.exam_date || student.matchDate || student.match_date) || null,
      dailyAvailableMinutes: Math.round(numberBetween(student.dailyHours || student.daily_hours, 1, 16, 3) * 60),
      weakAreas: (Array.isArray(student.weakAreas || student.selectedWeakAreas) ? student.weakAreas || student.selectedWeakAreas : []).map((row) => cleanText(row, 120)).filter(Boolean).slice(0, 20),
    },
    progressEvidence: {
      activeAssignments: activeAssignments(assignments).length,
      completedAssignments: assignments.filter((row) => String(row?.status || "").toLowerCase() === "completed").length,
      verifiedQuestionAttempts: questionSignals.count,
      verifiedQuestionAccuracyPercent: questionSignals.accuracyPercent,
      verifiedAssessmentAttempts: assessments.count,
      verifiedAssessmentAveragePercent: assessments.averagePercent,
      verifiedFullSelfAssessments: nbmeReadiness.completed_full_forms,
      readingProgressRecords: Math.max(0, Math.floor(numberBetween(input.surfaceProgress?.reading, 0, 1000000, 0))),
      videoProgressRecords: Math.max(0, Math.floor(numberBetween(input.surfaceProgress?.video, 0, 1000000, 0))),
      flashcardReviewRecords: Math.max(0, Math.floor(numberBetween(input.surfaceProgress?.flashcards, 0, 1000000, 0))),
      revisionQueueRecords: Math.max(0, Math.floor(numberBetween(input.surfaceProgress?.revision, 0, 1000000, 0))),
      notebookRecords: Math.max(0, Math.floor(numberBetween(input.surfaceProgress?.notebooks, 0, 1000000, 0))),
      systemProgressRecords: Array.isArray(input.systemProgress) ? input.systemProgress.length : 0,
    },
    workload,
    nextAction,
    assessment,
    nbmeReadiness,
    notebook,
    unfinishedWork,
    crossSystemWeakTopic: weakPattern,
    successStoryGuidance: {
      count: approvedStoryGuidance.length,
      strategies: approvedStoryGuidance,
      advisoryOnly: true,
      outcomeSummariesIncluded: false,
      changesRoadmapAutomatically: false,
    },
    weakSystemProgress: (Array.isArray(input.systemProgress) ? input.systemProgress : [])
      .filter((row) => row && Number.isFinite(Number(row.weaknessPercent)))
      .sort((left, right) => Number(right.weaknessPercent) - Number(left.weaknessPercent))
      .slice(0, 5)
      .map((row) => ({
        system: cleanText(row.system || "General", 120),
        masteryPercent: Number.isFinite(Number(row.masteryPercent)) ? Math.round(numberBetween(row.masteryPercent, 0, 100, 0)) : null,
        weaknessPercent: Math.round(numberBetween(row.weaknessPercent, 0, 100, 0)),
        improvementPercent: Number.isFinite(Number(row.improvementPercent)) ? Math.round(numberBetween(row.improvementPercent, -100, 100, 0)) : null,
        evidenceCount: Math.max(0, Math.floor(numberBetween(row.evidenceCount, 0, 1000000, 0))),
        trend: cleanText(row.trend || "baseline_needed", 60),
      })),
    recommendations,
    planChangeRecommendationIds: recommendations.filter((row) => row.planChange).map((row) => row.id),
  };
}

export function validateAylaPersonalTutorPlanCommand(command = {}, decision = {}) {
  if (!decision || decision.engine !== AYLA_PERSONAL_TUTOR_ENGINE) throw Object.assign(new Error("Personal Tutor decision is not connected to the authoritative roadmap engine"), { code: "TUTOR_ENGINE_MISMATCH" });
  const current = decision.generatedFromPlan || {};
  if (["completed", "cancelled", "superseded"].includes(String(current.status || "").toLowerCase())) {
    throw Object.assign(new Error("This roadmap day is no longer active and cannot be rebuilt by Personal Tutor"), { code: "TUTOR_PLAN_NOT_ACTIVE" });
  }
  const expectedPlanId = cleanText(command.expectedPlanId || command.expected_plan_id, 160);
  const expectedVersion = Math.max(0, Math.floor(numberBetween(command.expectedPlanVersion ?? command.expected_plan_version, 0, 1000000, 0)));
  if (!expectedPlanId || expectedPlanId !== String(current.id || "") || expectedVersion !== Number(current.version || 0)) {
    throw Object.assign(new Error("The roadmap changed after this tutor recommendation. Refresh Personal Tutor before applying it."), { code: "STALE_TUTOR_RECOMMENDATION" });
  }
  const recommendationId = cleanText(command.recommendationId || command.recommendation_id, 160);
  const selected = (Array.isArray(decision.recommendations) ? decision.recommendations : []).find((row) => row.id === recommendationId);
  if (!selected) throw Object.assign(new Error("Personal Tutor recommendation was not found for the current roadmap version"), { code: "TUTOR_RECOMMENDATION_NOT_FOUND" });
  if (selected.planChange !== true || selected.action !== "rebuild_single_roadmap") {
    throw Object.assign(new Error("This recommendation opens existing work and does not require changing the roadmap"), { code: "TUTOR_RECOMMENDATION_IS_NAVIGATION_ONLY" });
  }
  const directive = selected.directive && typeof selected.directive === "object" ? selected.directive : {};
  return {
    recommendation: selected,
    directive: {
      workloadAdjustment: ["reduce", "standard", "intensive"].includes(String(directive.workloadAdjustment)) ? String(directive.workloadAdjustment) : "standard",
      questionVolumeAdjustment: ["reduce", "standard", "intensive"].includes(String(directive.questionVolumeAdjustment)) ? String(directive.questionVolumeAdjustment) : "standard",
      includeAssessment: directive.includeAssessment === true,
    },
    commandKey: stableId("apply", expectedPlanId, expectedVersion, recommendationId),
  };
}

export function formatAylaPersonalTutorAnswer(decision = {}) {
  const next = decision.nextAction || {};
  const workload = decision.workload || {};
  const parts = [];
  if (next.assignmentId) parts.push(`Next, ${next.modality || "study"}: ${next.title}. ${next.reason}`);
  else parts.push(next.reason || "No verified roadmap assignment is ready yet.");
  if (workload.state === "overloaded") parts.push(`Your current load is too high, so I recommend about ${workload.recommendedQuestionCount || 5} questions and a version-checked roadmap rebalance.`);
  else if (workload.state === "ready_for_more") parts.push(`Your recent completion is strong, so the same roadmap can carefully increase question volume to about ${workload.recommendedQuestionCount || 5}.`);
  else parts.push("Your current workload is balanced; I would keep the stored roadmap unchanged.");
  if (decision.assessment?.state === "scheduled_in_current_plan") parts.push(`${decision.assessment.label} is already scheduled in this plan.`);
  if (decision.nbmeReadiness?.recommendation?.title) {
    parts.push(`${decision.nbmeReadiness.recommendation.title}. ${decision.nbmeReadiness.recommendation.reason}`);
  }
  if (decision.notebook) parts.push(`For recall, review your notebook entry “${decision.notebook.title}.”`);
  if (decision.crossSystemWeakTopic) parts.push(`${decision.crossSystemWeakTopic.topic} is appearing as a weak pattern across ${decision.crossSystemWeakTopic.systems.join(" and ")}.`);
  const successStrategy = decision.successStoryGuidance?.strategies?.[0];
  if (successStrategy?.strategySteps?.[0]?.action) parts.push(`An approved anonymized success story suggests adapting this tactic: ${successStrategy.strategySteps[0].action} This is guidance only; it does not promise the same outcome or replace your roadmap.`);
  return cleanText(parts.join(" "), 2400);
}
