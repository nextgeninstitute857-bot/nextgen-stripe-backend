export const CONTENT_DELIVERY_POLICY_VERSION = "source-year-media-integrity-v1";

export const CONTENT_DELIVERY_SOURCE_YEARS = Object.freeze([
  2026,
  2025,
  2024,
]);

const MIN_SOURCE_YEAR = 2000;
const MAX_SOURCE_YEAR = 2099;

function validSourceYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= MIN_SOURCE_YEAR && year <= MAX_SOURCE_YEAR
    ? year
    : null;
}

function sourceRankYear(value) {
  const rank = Number(value);
  if (!Number.isFinite(rank) || rank < MIN_SOURCE_YEAR * 10_000) return null;
  return validSourceYear(Math.trunc(rank / 10_000));
}

function textSourceYear(value = "") {
  const match = String(value || "").match(/(?:^|[^0-9])(20[0-9]{2})(?:[^0-9]|$)/);
  return validSourceYear(match?.[1]);
}

export function inferContentSourceYear(...values) {
  for (const value of values.flat(Infinity)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") {
      const nested = inferContentSourceYear(
        value.source_year,
        value.sourceYear,
        value.content_year,
        value.contentYear,
        sourceRankYear(value.source_rank ?? value.sourceRank),
        value.source_file,
        value.sourceFile,
        value.source_namespace,
        value.sourceNamespace,
        value.collection_key,
        value.collectionKey,
        value.collection_title,
        value.collectionTitle,
        value.original_filename,
        value.originalFilename,
        value.title,
      );
      if (nested) return nested;
      continue;
    }
    const explicit = validSourceYear(value);
    if (explicit) return explicit;
    const ranked = sourceRankYear(value);
    if (ranked) return ranked;
    const textual = textSourceYear(value);
    if (textual) return textual;
  }
  return null;
}

export function contentDeliveryPriorityRank(row = {}, {
  seenQuestionIds = new Set(),
} = {}) {
  const sourceYear = inferContentSourceYear(row);
  const yearIndex = CONTENT_DELIVERY_SOURCE_YEARS.indexOf(sourceYear);
  if (yearIndex < 0) return Number.POSITIVE_INFINITY;
  const questionId = String(row.id || row.question_id || row.contentQuestionId || "");
  const seen = seenQuestionIds instanceof Set
    ? seenQuestionIds.has(questionId)
    : Boolean(seenQuestionIds?.[questionId]);
  return yearIndex * 10 + (seen ? 1 : 0);
}

export function contentDeliveryPolicySnapshot() {
  return {
    version: CONTENT_DELIVERY_POLICY_VERSION,
    source_year_priority: [...CONTENT_DELIVERY_SOURCE_YEARS],
    fallback_strategy: "fill_newest_year_before_next_year",
    supported_media: ["image", "audio", "video"],
    media_changes_ranking: false,
    media_integrity_rule: "required_media_must_be_verified_and_playable",
    incomplete_or_quarantined_media_excluded: true,
    unseen_questions_first_within_year: true,
    active_sessions_remain_stable: true,
    flashcards_text_only: true,
  };
}
