export function updateDemoAccess(enrollment, { action } = {}, now = new Date()) {
  if (!enrollment || enrollment.is_demo !== true) {
    const error = new Error("This action is only available for demo enrollments. Paid access was not changed.");
    error.statusCode = 409;
    throw error;
  }
  if (!["extend", "revoke"].includes(action)) {
    const error = new Error("Choose extend or revoke.");
    error.statusCode = 400;
    throw error;
  }
  if (action === "extend") {
    // Date-only expiries are inclusive in the LMS.
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(enrollment.demo_expiry || "") ? `${enrollment.demo_expiry}T23:59:59.999Z` : enrollment.demo_expiry;
    const base = Math.max(now.getTime(), Date.parse(expiry || "") || 0);
    enrollment.demo_expiry = new Date(base + 2 * 86400000).toISOString();
    enrollment.access_granted = true;
    enrollment.revoked_at = null;
    enrollment.revoked_reason = null;
  } else {
    enrollment.access_granted = false;
    enrollment.revoked_at = now.toISOString();
    enrollment.revoked_reason = "admin_demo_revoke";
  }
  enrollment.updated_at = now.toISOString();
  return enrollment;
}
