export const AYLA_MCCQE_ROADMAP_BALANCE_VERSION = "mccqe-balanced-v3";

function boundedNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(minimum, Math.min(maximum, safe));
}

export function isMccqeRoadmapTrack(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .startsWith("mccqe");
}

export function buildAylaRoadmapBalancePolicy({
  examTrack = "",
  capacityMinutes = 180,
  isStudyDay = true,
  workloadFactor = 1,
} = {}) {
  const minimum = isStudyDay ? 60 : 15;
  const declaredCapacityMinutes = Math.round(boundedNumber(capacityMinutes, 180, minimum, 960));
  const adjustedCapacityMinutes = Math.round(boundedNumber(
    declaredCapacityMinutes * boundedNumber(workloadFactor, 1, 0.5, 1.25),
    declaredCapacityMinutes,
    minimum,
    960,
  ));
  const enabled = isMccqeRoadmapTrack(examTrack);
  const effectiveCapacityMinutes = enabled
    ? Math.min(declaredCapacityMinutes, adjustedCapacityMinutes)
    : adjustedCapacityMinutes;

  return {
    enabled,
    version: enabled ? AYLA_MCCQE_ROADMAP_BALANCE_VERSION : null,
    hardDailyCap: enabled,
    declaredCapacityMinutes,
    effectiveCapacityMinutes,
    priorityCarryCapMinutes: enabled && isStudyDay
      ? Math.max(15, Math.floor(effectiveCapacityMinutes * 0.35))
      : effectiveCapacityMinutes,
    qbankTargetMinutes: enabled && isStudyDay
      ? Math.max(12, Math.round(effectiveCapacityMinutes * 0.32))
      : 0,
    dueFlashcardCap: enabled
      ? Math.max(5, Math.min(15, Math.round(effectiveCapacityMinutes * 0.1)))
      : 20,
    questionMinutesPerItem: enabled ? 3 : 2,
  };
}

export function aylaRoadmapFitsWithin(value, addition, ceiling) {
  const current = Math.max(0, Number(value) || 0);
  const next = Math.max(0, Number(addition) || 0);
  const limit = Math.max(0, Number(ceiling) || 0);
  return current + next <= limit;
}

export function aylaRoadmapQuestionTarget(policy = {}, volumeFactor = 1) {
  if (!policy.enabled) return null;
  const minutes = Math.max(0, Number(policy.qbankTargetMinutes) || 0);
  const perQuestion = Math.max(1, Number(policy.questionMinutesPerItem) || 3);
  // MCCQE may reduce question volume after a difficult day, but an intensive
  // suggestion cannot steal the protected lecture share or exceed the day.
  const factor = Math.min(1, boundedNumber(volumeFactor, 1, 0.5, 1.25));
  return Math.max(1, Math.min(24, Math.round((minutes / perQuestion) * factor)));
}
