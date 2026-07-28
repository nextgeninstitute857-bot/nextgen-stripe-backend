function boundedInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

/**
 * Plan retention for the append-only CRM delivery-lock collection.
 *
 * Delivery locks are pushed in creation order and only the recent tail is
 * consulted for active-send deduplication. Keeping that tail avoids the
 * full-array object map and sort that can exhaust the production heap when
 * hundreds of thousands of historical locks are present.
 */
export function planCrmDeliveryLockRetention(
  records,
  {
    trigger = 8_000,
    keep = 4_000,
  } = {},
) {
  if (!Array.isArray(records)) return null;

  const triggerCount = boundedInteger(trigger, 8_000);
  const keepCount = Math.min(
    triggerCount,
    boundedInteger(keep, Math.min(4_000, triggerCount)),
  );

  if (records.length <= triggerCount) return null;

  const splitIndex = Math.max(0, records.length - keepCount);
  return {
    before: records.length,
    kept: keepCount,
    archived: splitIndex,
    keep: records.slice(splitIndex),
    archive: records.slice(0, splitIndex),
    strategy: "append_order_tail",
  };
}
