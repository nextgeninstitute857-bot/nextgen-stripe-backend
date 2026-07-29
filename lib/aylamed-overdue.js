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
