const SUCCESSFUL_PAYMENT_STATUSES = new Set(["paid", "completed", "succeeded"]);

function dateMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function paymentBelongsToEnrollment(payment = {}, enrollment = {}) {
  if (String(payment.enrollment_id || "") === String(enrollment.id || "")) return true;

  return (
    String(payment.user_id || payment.student_id || "") === String(enrollment.user_id || "")
    && String(payment.course_id || "") === String(enrollment.course_id || "")
    && (
      !payment.plan_id
      || !enrollment.plan_id
      || String(payment.plan_id) === String(enrollment.plan_id)
    )
  );
}

function successfulPaymentTimestamp(payment = {}) {
  const status = String(payment.status || payment.payment_status || payment.stripe_payment_status || "")
    .trim()
    .toLowerCase();
  if (!SUCCESSFUL_PAYMENT_STATUSES.has(status)) return 0;
  return Math.max(
    dateMs(payment.paid_at),
    dateMs(payment.created_at),
    dateMs(payment.updated_at),
  );
}

function paidEnrollmentCurrentlyActive(enrollment = {}, now = Date.now()) {
  if (!enrollment?.id || enrollment.is_demo === true || enrollment.access_granted === false) return false;
  const expiry = enrollment.access_expires_at || enrollment.expires_at || enrollment.renewal_due_at || null;
  if (!expiry) return true;
  const expiryMs = dateMs(expiry);
  return Boolean(expiryMs) && expiryMs >= now;
}

export function latestPaidActivationTimestamp(db = {}, enrollment = {}, paidAt = null) {
  if (!enrollment?.id || enrollment.is_demo === true) return 0;

  let latest = dateMs(paidAt);
  for (const payment of Object.values(db.payments || {})) {
    if (!paymentBelongsToEnrollment(payment, enrollment)) continue;
    latest = Math.max(latest, successfulPaymentTimestamp(payment));
  }

  latest = Math.max(latest, dateMs(enrollment.paid_at));
  if (enrollment.access_granted !== false) {
    latest = Math.max(
      latest,
      dateMs(enrollment.access_starts_at),
      dateMs(enrollment.created_at),
    );
  }

  return latest;
}

export function demoPredatesPaidActivation(db = {}, demo = {}, paid = {}, paidAt = null) {
  if (!demo?.id || demo.is_demo !== true || !paid?.id || paid.is_demo === true) return false;
  if (String(demo.user_id || "") !== String(paid.user_id || "")) return false;
  if (String(demo.course_id || "") !== String(paid.course_id || "")) return false;
  if (paidEnrollmentCurrentlyActive(paid)) return true;

  const paidActivationMs = latestPaidActivationTimestamp(db, paid, paidAt);
  if (!paidActivationMs) return false;
  const demoCreatedMs = Math.max(dateMs(demo.created_at), dateMs(demo.access_starts_at));
  return !demoCreatedMs || demoCreatedMs <= paidActivationMs;
}

export function supersedeDemoEnrollmentsForPaidAccess(
  db = {},
  paidEnrollment = {},
  { source = "paid_access", paidAt = null, at = null } = {},
) {
  const result = {
    changed: false,
    changed_count: 0,
    paid_enrollment_id: paidEnrollment?.id || null,
    demo_enrollment_ids: [],
  };
  const supersededAt = at || new Date().toISOString();

  for (const demo of Object.values(db.enrollments || {})) {
    if (!demoPredatesPaidActivation(db, demo, paidEnrollment, paidAt)) continue;
    if (demo.access_granted === false) continue;

    demo.access_granted = false;
    demo.revoked_at = supersededAt;
    demo.revoked_reason = "upgraded_to_paid";
    demo.superseded_by_enrollment_id = paidEnrollment.id;
    demo.superseded_at = supersededAt;
    demo.superseded_source = source;
    demo.updated_at = supersededAt;

    db.enrollments[demo.id] = demo;
    result.changed = true;
    result.changed_count += 1;
    result.demo_enrollment_ids.push(demo.id);
  }

  return result;
}

export function reconcilePaidDemoEnrollments(db = {}, { source = "paid_demo_reconciliation", at = null } = {}) {
  const result = {
    build: "v221-paid-demo-consolidation",
    source,
    checked_paid: 0,
    superseded_demo_count: 0,
    superseded_demo_ids: [],
    changed: false,
  };

  for (const enrollment of Object.values(db.enrollments || {})) {
    if (!enrollment?.id || enrollment.is_demo === true) continue;
    result.checked_paid += 1;
    const consolidated = supersedeDemoEnrollmentsForPaidAccess(db, enrollment, {
      source,
      at,
    });
    if (!consolidated.changed) continue;
    result.changed = true;
    result.superseded_demo_count += consolidated.changed_count;
    result.superseded_demo_ids.push(...consolidated.demo_enrollment_ids);
  }

  return result;
}
