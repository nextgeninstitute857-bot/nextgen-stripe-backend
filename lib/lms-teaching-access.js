const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LMS_FULL_TEACHING_PLAN_ID = "e0cc51d1-2a73-4699-9d9e-0d6bceacab90";
export const LMS_FULL_TEACHING_PLAN_DAYS = 120;
export const LMS_TEACHING_ACCESS_MODE = "course_teaching_schedule";

function cleanText(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return cleanText(value).toLowerCase();
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(value) {
  const clean = cleanText(value).slice(0, 10);
  return DATE_KEY_PATTERN.test(clean) ? clean : null;
}

function endOfTeachingDateIso(value) {
  const key = dateKey(value);
  return key ? `${key}T23:59:59.999Z` : null;
}

function roadmapDayIsNoClass(day = {}) {
  const status = cleanLower(day.status || day.roadmap_status || day.roadmapStatus);
  const text = cleanLower([
    day.title,
    day.topic,
    day.description,
    day.live_teaching_topic,
  ].filter(Boolean).join(" "));
  return (
    day.no_class_placeholder === true
    || day.is_no_class_day === true
    || day.is_schedule_placeholder === true
    || ["holiday", "cancelled", "canceled", "skipped", "no_class", "no-class", "no class"].includes(status)
    || text.includes("holiday / no live class")
    || text.includes("holiday/no live class")
    || text.includes("no live class")
    || text.includes("no class today")
    || text.includes("tutor unavailable")
    || text.includes("sunday off")
  );
}

function roadmapForCourse(db = {}, courseId = "") {
  const cleanCourseId = cleanText(courseId);
  if (!cleanCourseId) return null;
  const direct = db.roadmaps?.[cleanCourseId] || null;
  if (Array.isArray(direct?.days)) return direct;
  return Object.values(db.roadmaps || {}).find((roadmap) => (
    Array.isArray(roadmap?.days)
    && cleanText(roadmap.course_id || roadmap.courseId || roadmap.id) === cleanCourseId
  )) || null;
}

export function lmsPlanUsesTeachingSchedule(plan = {}) {
  const mode = cleanLower(
    plan.access_expiry_mode
      || plan.accessExpiryMode
      || plan.expiry_mode
      || plan.expiryMode,
  ).replace(/[\s-]+/g, "_");
  if (["course_teaching_schedule", "teaching_schedule", "roadmap_end"].includes(mode)) return true;

  const id = cleanText(plan.id);
  if (id === LMS_FULL_TEACHING_PLAN_ID) return true;

  const name = cleanLower(plan.name).replace(/\s+/g, " ");
  const billingType = cleanLower(plan.billing_type || plan.billingType || "one_time");
  return (
    name === "premium live batch"
    && Number(plan.price_cents || 0) === 35000
    && !billingType.includes("month")
    && !billingType.includes("subscription")
  );
}

export function summarizeCourseTeachingSchedule(db = {}, courseId = "", now = new Date()) {
  const roadmap = roadmapForCourse(db, courseId);
  const rows = Array.isArray(roadmap?.days) ? roadmap.days : [];
  const teachingRows = rows
    .map((day) => ({ day, date: dateKey(day.date || day.scheduled_date || day.scheduledDate) }))
    .filter(({ day, date }) => Boolean(date) && !roadmapDayIsNoClass(day))
    .sort((a, b) => a.date.localeCompare(b.date));
  const noClassRows = rows.filter(roadmapDayIsNoClass);
  const today = dateKey(now instanceof Date ? now.toISOString() : now) || new Date().toISOString().slice(0, 10);
  const elapsed = teachingRows.filter(({ date }) => date <= today).length;
  const finalRow = teachingRows.at(-1) || null;

  return {
    course_id: cleanText(courseId) || null,
    roadmap_found: Boolean(roadmap),
    schedule_rows: rows.length,
    teaching_days: teachingRows.length,
    no_class_days: noClassRows.length,
    teaching_days_elapsed: elapsed,
    teaching_days_remaining: Math.max(0, teachingRows.length - elapsed),
    current_teaching_day: elapsed,
    final_teaching_day: teachingRows.length || null,
    final_teaching_date: finalRow?.date || null,
    final_teaching_expiry_at: finalRow ? endOfTeachingDateIso(finalRow.date) : null,
    roadmap_updated_at: roadmap?.updated_at || roadmap?.updatedAt || null,
  };
}

export function resolveTeachingPlanExpiry(db = {}, enrollment = {}, plan = null, { now = new Date() } = {}) {
  const storedRaw = enrollment.access_expires_at || enrollment.expires_at || enrollment.renewal_due_at || null;
  const stored = validDate(storedRaw);
  const applies = lmsPlanUsesTeachingSchedule(plan || {});
  if (!applies) {
    return {
      applies: false,
      resolved: Boolean(stored),
      stored_expiry_at: stored?.toISOString() || null,
      effective_expiry_at: stored?.toISOString() || null,
      schedule: null,
    };
  }

  const schedule = summarizeCourseTeachingSchedule(db, enrollment.course_id, now);
  const program = validDate(schedule.final_teaching_expiry_at);
  const effective = !program
    ? stored
    : !stored || program.getTime() > stored.getTime()
      ? program
      : stored;

  return {
    applies: true,
    resolved: Boolean(effective),
    stored_expiry_at: stored?.toISOString() || null,
    program_expiry_at: program?.toISOString() || null,
    effective_expiry_at: effective?.toISOString() || null,
    extended_by_schedule: Boolean(program && (!stored || program.getTime() > stored.getTime())),
    schedule,
  };
}

function planEvidence(plan = {}) {
  const mode = cleanLower(plan.access_expiry_mode || plan.accessExpiryMode);
  if (mode) return "explicit_teaching_schedule_mode";
  if (cleanText(plan.id) === LMS_FULL_TEACHING_PLAN_ID) return "exact_full_plan_id";
  return "exact_full_plan_name_price_and_billing_type";
}

function clearWrongExpiryNotices(enrollment = {}) {
  const current = enrollment.billing_notifications_sent;
  if (!current || typeof current !== "object") return false;
  const next = { ...current };
  let changed = false;
  for (const key of ["renewal_7_days", "renewal_3_days", "renewal_1_days", "access_expired"]) {
    if (next[key] !== undefined) {
      delete next[key];
      changed = true;
    }
  }
  if (changed) enrollment.billing_notifications_sent = next;
  return changed;
}

export function reconcileConfirmedTeachingPlanAccess(db = {}, {
  dryRun = false,
  now = new Date(),
  source = "teaching_access_reconciliation",
} = {}) {
  const nowDate = now instanceof Date ? new Date(now) : new Date(now);
  const safeNow = Number.isNaN(nowDate.getTime()) ? new Date() : nowDate;
  const riskCutoff = safeNow.getTime() + (7 * DAY_MS);
  const rows = [];
  const confirmedUsers = new Set();
  const atRiskUsers = new Set();
  const schedules = new Map();
  let plansUpdated = 0;
  let enrollmentsUpdated = 0;
  let autoExpiredRestored = 0;
  let skippedManualRevocations = 0;
  let unresolvedSchedules = 0;

  for (const plan of Object.values(db.plans || {})) {
    if (!lmsPlanUsesTeachingSchedule(plan)) continue;
    const needsPlanUpdate = (
      Number(plan.access_days || 0) !== LMS_FULL_TEACHING_PLAN_DAYS
      || cleanLower(plan.access_expiry_mode) !== LMS_TEACHING_ACCESS_MODE
      || Number(plan.minimum_teaching_days || 0) !== LMS_FULL_TEACHING_PLAN_DAYS
    );
    if (needsPlanUpdate) {
      plansUpdated += 1;
      if (!dryRun) {
        plan.access_days = LMS_FULL_TEACHING_PLAN_DAYS;
        plan.access_expiry_mode = LMS_TEACHING_ACCESS_MODE;
        plan.minimum_teaching_days = LMS_FULL_TEACHING_PLAN_DAYS;
        plan.updated_at = safeNow.toISOString();
      }
    }
  }

  for (const enrollment of Object.values(db.enrollments || {})) {
    if (!enrollment?.id || enrollment.is_demo === true || !enrollment.plan_id) continue;
    const plan = db.plans?.[String(enrollment.plan_id)] || null;
    if (!plan || !lmsPlanUsesTeachingSchedule(plan)) continue;

    const userCourseKey = `${enrollment.user_id || enrollment.id}:${enrollment.course_id || ""}`;
    confirmedUsers.add(userCourseKey);
    const resolution = resolveTeachingPlanExpiry(db, enrollment, plan, { now: safeNow });
    const schedule = resolution.schedule;
    if (schedule?.course_id && !schedules.has(schedule.course_id)) schedules.set(schedule.course_id, schedule);
    if (!resolution.program_expiry_at) {
      unresolvedSchedules += 1;
      rows.push({
        enrollment_id: enrollment.id,
        user_id: enrollment.user_id || null,
        course_id: enrollment.course_id || null,
        plan_id: enrollment.plan_id,
        plan_evidence: planEvidence(plan),
        action: "unresolved_schedule",
      });
      continue;
    }

    const stored = validDate(resolution.stored_expiry_at);
    const originalStored = validDate(enrollment.teaching_access_previous_expiry_at) || stored;
    const effective = validDate(resolution.effective_expiry_at);
    const autoExpired = (
      enrollment.access_granted === false
      && cleanLower(enrollment.revoked_reason) === "access_expired"
    );
    const manuallyRevoked = enrollment.access_granted === false && !autoExpired;
    const atRisk = Boolean(originalStored && originalStored.getTime() <= riskCutoff);
    if (atRisk && !manuallyRevoked) atRiskUsers.add(userCourseKey);

    if (manuallyRevoked) {
      skippedManualRevocations += 1;
      rows.push({
        enrollment_id: enrollment.id,
        user_id: enrollment.user_id || null,
        course_id: enrollment.course_id || null,
        plan_id: enrollment.plan_id,
        plan_evidence: planEvidence(plan),
        stored_expiry_at: resolution.stored_expiry_at,
        effective_expiry_at: resolution.effective_expiry_at,
        action: "skipped_manual_revocation",
      });
      continue;
    }

    const needsExpiryUpdate = Boolean(effective && (
      !stored || effective.getTime() !== stored.getTime()
    ));
    const needsRestore = Boolean(autoExpired && effective && effective.getTime() >= safeNow.getTime());
    const needsMetadata = (
      cleanLower(enrollment.access_expiry_mode) !== LMS_TEACHING_ACCESS_MODE
      || Number(enrollment.minimum_teaching_days || 0) !== LMS_FULL_TEACHING_PLAN_DAYS
      || Number(enrollment.program_teaching_days || 0) !== Number(schedule.teaching_days || 0)
      || cleanText(enrollment.program_final_teaching_date) !== cleanText(schedule.final_teaching_date)
    );
    const noticesNeedReset = (needsExpiryUpdate || needsRestore) && (
      ["renewal_7_days", "renewal_3_days", "renewal_1_days", "access_expired"]
        .some((key) => enrollment.billing_notifications_sent?.[key] !== undefined)
    );
    const changed = needsExpiryUpdate || needsRestore || needsMetadata || noticesNeedReset;

    if (changed) {
      enrollmentsUpdated += 1;
      if (needsRestore) autoExpiredRestored += 1;
      if (!dryRun) {
        if (needsExpiryUpdate) {
          enrollment.teaching_access_previous_expiry_at =
            enrollment.teaching_access_previous_expiry_at
            || resolution.stored_expiry_at
            || null;
          enrollment.access_expires_at = resolution.effective_expiry_at;
          enrollment.renewal_due_at = resolution.effective_expiry_at;
        }
        enrollment.access_days = LMS_FULL_TEACHING_PLAN_DAYS;
        enrollment.access_expiry_mode = LMS_TEACHING_ACCESS_MODE;
        enrollment.minimum_teaching_days = LMS_FULL_TEACHING_PLAN_DAYS;
        enrollment.program_teaching_days = Number(schedule.teaching_days || LMS_FULL_TEACHING_PLAN_DAYS);
        enrollment.program_final_teaching_date = schedule.final_teaching_date;
        enrollment.teaching_access_reconciled_at = safeNow.toISOString();
        enrollment.teaching_access_reconciliation_source = source;
        if (needsRestore) {
          enrollment.access_granted = true;
          enrollment.revoked_at = null;
          enrollment.revoked_reason = null;
          enrollment.restored_from_wrong_expiry_at = safeNow.toISOString();
        }
        if (noticesNeedReset) clearWrongExpiryNotices(enrollment);
        enrollment.updated_at = safeNow.toISOString();
      }
    }

    rows.push({
      enrollment_id: enrollment.id,
      user_id: enrollment.user_id || null,
      course_id: enrollment.course_id || null,
      plan_id: enrollment.plan_id,
      plan_evidence: planEvidence(plan),
      stored_expiry_at: resolution.stored_expiry_at,
      original_stored_expiry_at: originalStored?.toISOString() || null,
      effective_expiry_at: resolution.effective_expiry_at,
      final_teaching_date: schedule.final_teaching_date,
      teaching_days: schedule.teaching_days,
      teaching_days_elapsed: schedule.teaching_days_elapsed,
      teaching_days_remaining: schedule.teaching_days_remaining,
      at_risk_under_stored_expiry: atRisk,
      action: needsRestore
        ? "restore_auto_expiry_and_extend"
        : changed
          ? "extend_to_teaching_schedule"
          : "already_protected",
    });
  }

  return {
    source,
    dry_run: dryRun,
    checked_at: safeNow.toISOString(),
    changed: !dryRun && (plansUpdated > 0 || enrollmentsUpdated > 0),
    confirmed_enrollment_rows: rows.length,
    confirmed_unique_students: confirmedUsers.size,
    at_risk_unique_students: atRiskUsers.size,
    plans_updated: plansUpdated,
    enrollments_updated: enrollmentsUpdated,
    auto_expired_restored: autoExpiredRestored,
    skipped_manual_revocations: skippedManualRevocations,
    unresolved_schedules: unresolvedSchedules,
    schedules: [...schedules.values()],
    rows,
  };
}
