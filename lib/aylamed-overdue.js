function cleanLinkedAssignmentIds(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (value === null || value === undefined || value === "") return [];
  return [String(value).trim()].filter(Boolean);
}

export function aylaOverdueBaseTitle(value = "") {
  const clean = String(value || "")
    .replace(/^(?:\s*overdue\s*:\s*)+/i, "")
    .trim();
  return clean || "Priority assignment";
}

export function aylaOverdueTitle(value = "") {
  return `Overdue: ${aylaOverdueBaseTitle(value)}`;
}

export function aylaOriginalOverdueAssignment(row = {}) {
  if (row.overdueCarry === true || row.overdue_carry === true) return false;
  if (String(row.category || "").trim().toLowerCase() === "overdue_review") return false;
  return cleanLinkedAssignmentIds(
    row.linkedAssignmentIds || row.linked_assignment_ids,
  ).length === 0;
}

// Catch-up work older than this many days is retired instead of being carried
// forward forever; the planner then schedules fresh work on the same topics.
export const AYLA_CATCH_UP_MAX_AGE_DAYS = 7;

const CLOSED_ASSIGNMENT_STATUSES = new Set(["completed", "skipped", "cancelled", "superseded", "moved"]);

export function aylaCatchUpCutoffDate(date = "", maxAgeDays = AYLA_CATCH_UP_MAX_AGE_DAYS) {
  const day = String(date || "").slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime())) return "";
  parsed.setUTCDate(parsed.getUTCDate() - Math.max(1, Number(maxAgeDays) || AYLA_CATCH_UP_MAX_AGE_DAYS));
  return parsed.toISOString().slice(0, 10);
}

// Returns the unfinished originals scheduled before the cutoff, plus any
// catch-up copies of them dated up to today (future rows are never touched).
export function aylaExpiredCatchUpAssignments(rows = [], date = "", { maxAgeDays = AYLA_CATCH_UP_MAX_AGE_DAYS } = {}) {
  const cutoff = aylaCatchUpCutoffDate(date, maxAgeDays);
  if (!cutoff) return { cutoff: "", roots: [], copies: [] };
  const open = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && !CLOSED_ASSIGNMENT_STATUSES.has(String(row.status || "pending").toLowerCase()));
  const roots = open.filter((row) => aylaOriginalOverdueAssignment(row)
    && String(row.scheduledDate || "") !== ""
    && String(row.scheduledDate) < cutoff);
  const rootIds = new Set(roots.map((row) => String(row.id)));
  const copies = open.filter((row) => !aylaOriginalOverdueAssignment(row)
    && String(row.scheduledDate || "") <= String(date).slice(0, 10)
    && [
      ...cleanLinkedAssignmentIds(row.linkedAssignmentIds || row.linked_assignment_ids),
      ...cleanLinkedAssignmentIds(row.overdueRootAssignmentIds || row.overdue_root_assignment_ids),
    ].some((id) => rootIds.has(id)));
  return { cutoff, roots, copies };
}
