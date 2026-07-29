import crypto from "node:crypto";

export const AYLA_CONTINUITY_EXAM_TRACKS = Object.freeze([
  "usmle_step_1",
  "usmle_step_2_ck",
  "usmle_step_3",
  "plab",
  "amc",
  "mccqe",
  "nclex",
]);

const EXAM_ALIASES = new Map([
  ["usmle step 1", "usmle_step_1"],
  ["step 1", "usmle_step_1"],
  ["step1", "usmle_step_1"],
  ["usmle step 2 ck", "usmle_step_2_ck"],
  ["step 2 ck", "usmle_step_2_ck"],
  ["step 2", "usmle_step_2_ck"],
  ["step2", "usmle_step_2_ck"],
  ["usmle step 3", "usmle_step_3"],
  ["step 3", "usmle_step_3"],
  ["step3", "usmle_step_3"],
  ["plab", "plab"],
  ["amc", "amc"],
  ["mccqe", "mccqe"],
  ["nclex", "nclex"],
]);

const AUTO_PROGRESSION = Object.freeze({
  usmle_step_1: "usmle_step_2_ck",
  usmle_step_2_ck: "usmle_step_3",
});

function clean(value = "", limit = 500) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, limit);
}

function normalized(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanList(values = [], limit = 20) {
  const list = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(list.map((value) => clean(value, 120)).filter(Boolean))].slice(0, limit);
}

function boundedNumber(value, fallback = 0, minimum = 0, maximum = 100000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function validTimeZone(value = "") {
  const timeZone = clean(value, 120);
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}

function localDateParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now instanceof Date ? now : new Date(now))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour || 0),
  };
}

function insideQuietHours(hour, start, end) {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeAylaContinuityExamTrack(value = "") {
  const label = normalized(value);
  if (!label) return null;
  const underscored = label.replace(/\s+/g, "_");
  if (AYLA_CONTINUITY_EXAM_TRACKS.includes(underscored)) return underscored;
  return EXAM_ALIASES.get(label) || null;
}

export function suggestAylaNextExam(sourceExamTrack = "") {
  const source = normalizeAylaContinuityExamTrack(sourceExamTrack);
  return source ? AUTO_PROGRESSION[source] || null : null;
}

export function normalizeAylaEngagementPreferences(input = {}, current = {}) {
  const source = { ...(current || {}), ...(input || {}) };
  return {
    coachingEmailOptIn: source.coachingEmailOptIn === true || source.coaching_email_opt_in === true,
    weeklySummaryEmailOptIn: source.weeklySummaryEmailOptIn === true
      || source.weekly_summary_email_opt_in === true,
    examTransitionEmailOptIn: source.examTransitionEmailOptIn === true
      || source.exam_transition_email_opt_in === true,
    reactivationEmailOptIn: source.reactivationEmailOptIn === true
      || source.reactivation_email_opt_in === true,
    accountEmailEnabled: source.accountEmailEnabled !== false
      && source.account_email_enabled !== false,
    timezone: validTimeZone(source.timezone || current.timezone || "UTC"),
    quietHoursStart: Math.trunc(boundedNumber(
      source.quietHoursStart ?? source.quiet_hours_start,
      21,
      0,
      23,
    )),
    quietHoursEnd: Math.trunc(boundedNumber(
      source.quietHoursEnd ?? source.quiet_hours_end,
      8,
      0,
      23,
    )),
    weeklySummaryDay: clean(
      source.weeklySummaryDay || source.weekly_summary_day || "Sunday",
      20,
    ),
    maxCoachingEmailsPerDay: Math.trunc(boundedNumber(
      source.maxCoachingEmailsPerDay ?? source.max_coaching_emails_per_day,
      1,
      0,
      2,
    )),
    updatedAt: source.updatedAt || source.updated_at || null,
  };
}

export function buildAylaCarryContext({
  sourceStudent = {},
  behaviorEvidence = {},
  revisionItems = [],
} = {}) {
  const sourceExamTrack = normalizeAylaContinuityExamTrack(
    sourceStudent.examTrackId || sourceStudent.exam_track_id || sourceStudent.exam,
  );
  const seenRevisionKeys = new Set();
  const revisionReferences = [];
  for (const item of Array.isArray(revisionItems) ? revisionItems : []) {
    const system = clean(item.system, 120);
    const subsystem = clean(
      item.subsystem || item.subsystemName || item.subsystem_name,
      160,
    );
    const topic = clean(item.topic, 240);
    if (!system && !topic) continue;
    const key = `${system.toLowerCase()}\u001f${subsystem.toLowerCase()}\u001f${topic.toLowerCase()}`;
    if (seenRevisionKeys.has(key)) continue;
    seenRevisionKeys.add(key);
    revisionReferences.push({
      system,
      subsystem,
      topic,
      reason: clean(
        Array.isArray(item.reasons) ? item.reasons.join(", ") : item.reason,
        300,
      ),
      sourceExamTrack,
      referenceOnly: true,
      appliedToTargetMastery: false,
    });
    if (revisionReferences.length >= 50) break;
  }
  return {
    sourceExamTrack,
    studyBehavior: {
      timezone: validTimeZone(sourceStudent.timezone || "UTC"),
      dailyHours: boundedNumber(
        sourceStudent.dailyHours ?? sourceStudent.daily_hours,
        0,
        0,
        24,
      ),
      weeklyStudyDays: Math.trunc(boundedNumber(
        sourceStudent.weeklyStudyDays ?? sourceStudent.weekly_study_days,
        0,
        0,
        7,
      )),
      preferredStudyDays: cleanList(
        sourceStudent.preferredStudyDays || sourceStudent.preferred_study_days,
        7,
      ),
      sessionLengthMinutes: Math.trunc(boundedNumber(
        sourceStudent.sessionLength ?? sourceStudent.session_length,
        0,
        0,
        360,
      )),
      restDay: clean(sourceStudent.restDay || sourceStudent.rest_day, 30),
      completedStudyDays: Math.trunc(boundedNumber(behaviorEvidence.completedStudyDays, 0, 0, 10000)),
      missedStudyDays: Math.trunc(boundedNumber(behaviorEvidence.missedStudyDays, 0, 0, 10000)),
      averageCompletedMinutes: Math.trunc(boundedNumber(
        behaviorEvidence.averageCompletedMinutes,
        0,
        0,
        24 * 60,
      )),
    },
    revisionReferences,
    transferPolicy: {
      behaviorMayPrefillTargetSetup: true,
      revisionIsReferenceOnlyUntilTargetBaseline: true,
      copiedSourceScores: false,
      copiedSourceAnswers: false,
      copiedSourceBaseline: false,
      copiedSourceReadiness: false,
      copiedSourceWeakAreaMastery: false,
      targetEntitlementRequired: true,
      newTargetBaselineRequired: true,
    },
  };
}

export function buildAylaExamHandoffState({
  sourceExamTrack = "",
  targetExamTrack = "",
  sourceCompletionStatus = "unconfirmed",
  targetEntitled = false,
  targetProfileExists = false,
  targetBaselineVerified = false,
} = {}) {
  const source = normalizeAylaContinuityExamTrack(sourceExamTrack);
  const target = normalizeAylaContinuityExamTrack(targetExamTrack);
  if (!source) throw Object.assign(new Error("A supported source exam is required"), { code: "INVALID_SOURCE_EXAM" });
  if (!target) throw Object.assign(new Error("A supported target exam is required"), { code: "INVALID_TARGET_EXAM" });
  if (source === target) throw Object.assign(new Error("The target exam must differ from the source exam"), { code: "SAME_EXAM_HANDOFF" });
  const completion = normalized(sourceCompletionStatus);
  const sourceComplete = [
    "verified",
    "confirmed",
    "completed",
    "self reported completed",
    "self reported passed",
  ].includes(completion);
  let state = "awaiting_source_completion";
  if (sourceComplete && !targetEntitled) state = "awaiting_target_entitlement";
  else if (sourceComplete && targetEntitled && !targetProfileExists) state = "target_setup_required";
  else if (sourceComplete && targetEntitled && targetProfileExists && !targetBaselineVerified) {
    state = "baseline_required";
  } else if (sourceComplete && targetEntitled && targetProfileExists && targetBaselineVerified) {
    state = "activated";
  }
  return {
    state,
    sourceExamTrack: source,
    targetExamTrack: target,
    sourceComplete,
    targetEntitled: targetEntitled === true,
    targetProfileExists: targetProfileExists === true,
    targetBaselineVerified: targetBaselineVerified === true,
    targetRoadmapMayUseCarryContext: state === "activated",
    targetRoadmapMayUseSourceScores: false,
    nextAction: state === "awaiting_source_completion"
      ? "confirm_source_exam_completion"
      : state === "awaiting_target_entitlement"
        ? "obtain_target_exam_entitlement"
        : state === "target_setup_required"
          ? "create_target_exam_dashboard"
          : state === "baseline_required"
            ? "complete_new_target_baseline"
            : "continue_target_adaptive_roadmap",
  };
}

export function createAylaExamHandoff({
  idFactory = () => `AYLA-HANDOFF-${crypto.randomUUID()}`,
  now = new Date(),
  userId = "",
  sourceStudentId = "",
  targetStudentId = "",
  sourceCompletionStatus = "unconfirmed",
  sourceExamTrack = "",
  targetExamTrack = "",
  targetEntitled = false,
  targetProfileExists = false,
  targetBaselineVerified = false,
  carryContext = {},
} = {}) {
  const status = buildAylaExamHandoffState({
    sourceExamTrack,
    targetExamTrack,
    sourceCompletionStatus,
    targetEntitled,
    targetProfileExists,
    targetBaselineVerified,
  });
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    id: clean(idFactory(), 180),
    userId: clean(userId, 180),
    sourceStudentId: clean(sourceStudentId, 180),
    targetStudentId: clean(targetStudentId, 180) || null,
    sourceExamTrack: status.sourceExamTrack,
    targetExamTrack: status.targetExamTrack,
    sourceCompletionStatus: clean(sourceCompletionStatus, 80),
    status: status.state,
    nextAction: status.nextAction,
    carryContext,
    sourceScoresCopied: false,
    sourceAnswersCopied: false,
    sourceBaselineCopied: false,
    targetBaselineRequired: true,
    targetBaselineVerified: status.targetBaselineVerified,
    targetEntitled: status.targetEntitled,
    createdAt,
    updatedAt: createdAt,
  };
}

function engagementMessage(kind, facts = {}) {
  const firstName = clean(facts.firstName || "there", 80);
  const savedData = "Your eligible AylaMed study history remains tied to your account under the current retention and deletion settings.";
  if (kind === "daily_incomplete") {
    const remaining = Math.max(1, Math.trunc(Number(facts.remainingTasks) || 1));
    const minutes = Math.max(5, Math.trunc(Number(facts.minutesRemaining) || 15));
    return {
      subject: `${remaining} focused task${remaining === 1 ? "" : "s"} remain today`,
      text: `Hi ${firstName},\n\nYou completed ${facts.completedTasks || 0} of ${facts.totalTasks || remaining} planned tasks today. ${remaining} focused task${remaining === 1 ? "" : "s"} remain, estimated at about ${minutes} minutes.\n\nIf today no longer works, AylaMed can replan future work without erasing completed history. Open Today when you are ready and finish the smallest useful next step.\n\n${savedData}`,
    };
  }
  if (kind === "weekly_progress") {
    const estimate = facts.readinessDaysLow && facts.readinessDaysHigh
      ? ` At your current verified pace, the planning estimate is approximately ${facts.readinessDaysLow}–${facts.readinessDaysHigh} days; this is not a pass guarantee.`
      : "";
    return {
      subject: "Your AylaMed weekly progress",
      text: `Hi ${firstName},\n\nThis week you completed ${facts.completedThisWeek || 0} of ${facts.plannedThisWeek || 0} planned study tasks.${facts.improvementPercent !== null && facts.improvementPercent !== undefined ? ` Verified performance changed by ${facts.improvementPercent} percentage points.` : ""}${estimate}\n\nYour next plan will continue from completed work and replan only future tasks.\n\n${savedData}`,
    };
  }
  if (kind === "renewal_notice") {
    const days = Math.max(1, Math.trunc(Number(facts.daysRemaining) || 1));
    return {
      subject: `AylaMed access: ${days} day${days === 1 ? "" : "s"} remaining`,
      text: `Hi ${firstName},\n\nYour ${facts.examLabel || "exam"} access is scheduled to expire or renew in ${days} day${days === 1 ? "" : "s"}. Review your billing status if you want uninterrupted access to the adaptive roadmap.\n\n${savedData} A different exam still requires its own entitlement and a new baseline.`,
    };
  }
  if (kind === "access_expired") {
    return {
      subject: "Your AylaMed exam access is inactive",
      text: `Hi ${firstName},\n\nYour ${facts.examLabel || "exam"} subscription is currently inactive. ${savedData}\n\nRenew only if you want to continue using the roadmap, Tutor and revision tools. No prior exam score will be reused as a new exam baseline.`,
    };
  }
  if (kind === "reactivation") {
    return {
      subject: "Continue from your saved AylaMed study history",
      text: `Hi ${firstName},\n\nIf you are continuing ${facts.examLabel || "your exam preparation"}, you can reactivate access and review the eligible history saved under your account. AylaMed will show what was completed and what remains before creating future work.\n\nThere is no penalty for waiting, and you can opt out of coaching messages at any time.`,
    };
  }
  return {
    subject: `Your ${facts.targetExamLabel || "next exam"} setup is ready`,
    text: `Hi ${firstName},\n\nYour prior study-behavior preferences and reference-only revision context can help set up the next dashboard. To begin ${facts.targetExamLabel || "the target exam"}, activate the exam-specific entitlement and complete a new baseline.\n\nYour prior score, answers, mastery and readiness are not copied into the new exam.`,
  };
}

export function buildAylaEngagementMessages({
  now = new Date(),
  student = {},
  user = {},
  enrollment = null,
  progress = {},
  handoff = null,
  preferences = {},
  deliveries = [],
} = {}) {
  const nowValue = now instanceof Date ? now : new Date(now);
  const nowMs = nowValue.getTime();
  const resolvedPreferences = normalizeAylaEngagementPreferences(preferences, {
    timezone: student.timezone,
  });
  const local = localDateParts(nowValue, resolvedPreferences.timezone);
  const quiet = insideQuietHours(
    local.hour,
    resolvedPreferences.quietHoursStart,
    resolvedPreferences.quietHoursEnd,
  );
  const prior = Array.isArray(deliveries) ? deliveries : [];
  const deliveryBlocksDuplicate = (row) => {
    const status = String(row.status || "").toLowerCase();
    if (["sent", "delivered"].includes(status)) return true;
    if (status !== "queued") return false;
    const claimExpiry = timestamp(row.claimExpiresAt || row.claim_expires_at);
    return claimExpiry ? claimExpiry > nowMs : true;
  };
  const sentKeys = new Set(
    prior.filter(deliveryBlocksDuplicate)
      .map((row) => String(row.messageKey || row.message_key || "")),
  );
  const todayCoachingCount = prior.filter((row) => (
    String(row.category || "") === "coaching"
    && String(row.localDateKey || row.local_date_key || "") === local.dateKey
    && deliveryBlocksDuplicate(row)
  )).length;
  const messages = [];
  const suppressed = [];
  const facts = {
    firstName: clean(user.name || student.name || "there", 80).split(/\s+/)[0],
    examLabel: clean(student.exam || student.examTrackId || "exam", 120),
  };

  function propose(kind, {
    category,
    consent,
    key,
    messageFacts = {},
  }) {
    if (!consent) {
      suppressed.push({ kind, reason: "consent_required", messageKey: key });
      return;
    }
    if (sentKeys.has(key)) {
      suppressed.push({ kind, reason: "already_delivered", messageKey: key });
      return;
    }
    if (quiet) {
      suppressed.push({ kind, reason: "quiet_hours", messageKey: key });
      return;
    }
    if (
      category === "coaching"
      && todayCoachingCount + messages.filter((row) => row.category === "coaching").length
        >= resolvedPreferences.maxCoachingEmailsPerDay
    ) {
      suppressed.push({ kind, reason: "daily_frequency_cap", messageKey: key });
      return;
    }
    messages.push({
      kind,
      category,
      channel: "email",
      messageKey: key,
      localDateKey: local.dateKey,
      ...engagementMessage(kind, { ...facts, ...messageFacts }),
    });
  }

  const totalToday = Math.max(0, Math.trunc(Number(progress.totalTasksToday) || 0));
  const completedToday = Math.max(0, Math.min(totalToday, Math.trunc(Number(progress.completedTasksToday) || 0)));
  const remainingToday = Math.max(0, totalToday - completedToday);
  if (remainingToday > 0 && local.hour >= 18) {
    propose("daily_incomplete", {
      category: "coaching",
      consent: resolvedPreferences.coachingEmailOptIn,
      key: `daily_incomplete:${student.id || "student"}:${local.dateKey}`,
      messageFacts: {
        completedTasks: completedToday,
        totalTasks: totalToday,
        remainingTasks: remainingToday,
        minutesRemaining: progress.minutesRemainingToday,
      },
    });
  }

  if (
    local.weekday.toLowerCase() === resolvedPreferences.weeklySummaryDay.toLowerCase()
    && local.hour >= 17
  ) {
    propose("weekly_progress", {
      category: "coaching",
      consent: resolvedPreferences.weeklySummaryEmailOptIn,
      key: `weekly_progress:${student.id || "student"}:${local.dateKey}`,
      messageFacts: {
        completedThisWeek: progress.completedTasksThisWeek,
        plannedThisWeek: progress.plannedTasksThisWeek,
        improvementPercent: progress.verifiedImprovementPercent ?? null,
        readinessDaysLow: progress.readinessDaysLow,
        readinessDaysHigh: progress.readinessDaysHigh,
      },
    });
  }

  const expiry = timestamp(
    enrollment?.access_expires_at
      || enrollment?.accessExpiresAt
      || enrollment?.expires_at
      || enrollment?.expiresAt,
  );
  if (expiry) {
    const daysRemaining = Math.ceil((expiry - new Date(now).getTime()) / 86400000);
    if ([7, 3, 1].includes(daysRemaining)) {
      propose("renewal_notice", {
        category: "transactional",
        consent: resolvedPreferences.accountEmailEnabled,
        key: `renewal_notice:${enrollment.id || "enrollment"}:${daysRemaining}`,
        messageFacts: { daysRemaining },
      });
    } else if (daysRemaining <= 0 && daysRemaining >= -1) {
      propose("access_expired", {
        category: "transactional",
        consent: resolvedPreferences.accountEmailEnabled,
        key: `access_expired:${enrollment.id || "enrollment"}`,
      });
    } else if ([-7, -21].includes(daysRemaining)) {
      propose("reactivation", {
        category: "coaching",
        consent: resolvedPreferences.reactivationEmailOptIn,
        key: `reactivation:${enrollment.id || "enrollment"}:${Math.abs(daysRemaining)}`,
      });
    }
  }

  if (handoff && ["awaiting_target_entitlement", "target_setup_required", "baseline_required"].includes(handoff.status)) {
    propose("exam_handoff", {
      category: "coaching",
      consent: resolvedPreferences.examTransitionEmailOptIn,
      key: `exam_handoff:${handoff.id}:${handoff.status}`,
      messageFacts: {
        targetExamLabel: clean(handoff.targetExamLabel || handoff.targetExamTrack, 120),
      },
    });
  }

  return {
    generatedAt: nowValue.toISOString(),
    timeZone: resolvedPreferences.timezone,
    localDateKey: local.dateKey,
    quietHoursActive: quiet,
    preferences: resolvedPreferences,
    messages,
    suppressed,
  };
}
