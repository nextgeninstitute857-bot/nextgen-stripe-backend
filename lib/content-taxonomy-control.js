import { normalizeExamTrack } from "./content-import-adapter.js";

export const CONTENT_TAXONOMY_EXAM_TRACKS = Object.freeze([
  { id: "usmle-step-1", label: "USMLE Step 1" },
  { id: "usmle-step-2", label: "USMLE Step 2 CK" },
  { id: "usmle-step-3", label: "USMLE Step 3" },
  { id: "plab", label: "PLAB" },
  { id: "amc", label: "AMC" },
  { id: "mccqe", label: "MCCQE" },
  { id: "nclex", label: "NCLEX" },
]);

const EXAM_TRACK_IDS = new Set(CONTENT_TAXONOMY_EXAM_TRACKS.map((exam) => exam.id));
const REVIEW_ACTIONS = new Set(["approve", "reject", "disable", "reopen"]);
const REVIEW_STATES = new Set(["approved", "needs_review", "rejected", "disabled", "unmapped"]);

function boundedText(value = "", max = 180) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function countValue(value) {
  return Math.max(0, Math.trunc(numberValue(value, 0)));
}

export function normalizeContentTaxonomyExamTrack(value = "") {
  const examTrack = normalizeExamTrack(value);
  return EXAM_TRACK_IDS.has(examTrack) ? examTrack : null;
}

export function normalizeContentTaxonomyKey(value = "") {
  return boundedText(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function cleanLabels(labels = {}) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(Object.entries(labels)
    .slice(0, 30)
    .map(([key, value]) => [normalizeContentTaxonomyKey(key), boundedText(value, 180)])
    .filter(([key, value]) => key && value));
}

export function normalizeContentTaxonomy(taxonomy = {}, {
  requireTopic = false,
  requireHierarchy = false,
} = {}) {
  const value = taxonomy && typeof taxonomy === "object" ? taxonomy : {};
  const normalized = {
    system_key: normalizeContentTaxonomyKey(value.system_key || value.systemKey),
    subsystem_key: normalizeContentTaxonomyKey(value.subsystem_key || value.subsystemKey),
    topic_key: normalizeContentTaxonomyKey(value.topic_key || value.topicKey),
    subtopic_key: normalizeContentTaxonomyKey(value.subtopic_key || value.subtopicKey),
    labels: cleanLabels(value.labels),
  };
  if (!normalized.system_key) throw Object.assign(new Error("system_key is required"), { statusCode: 400 });
  if ((requireTopic || requireHierarchy) && !normalized.topic_key) {
    throw Object.assign(new Error("topic_key is required"), { statusCode: 400 });
  }
  if (requireHierarchy && !normalized.subsystem_key) {
    throw Object.assign(new Error("subsystem_key is required"), { statusCode: 400 });
  }
  if (requireHierarchy && !normalized.subtopic_key) {
    throw Object.assign(new Error("subtopic_key is required"), { statusCode: 400 });
  }
  return normalized;
}

export function normalizeContentTaxonomyReviewAction(value = "") {
  const action = boundedText(value, 40).toLowerCase().replace(/[\s-]+/g, "_").replace(/^re_open$/, "reopen");
  return REVIEW_ACTIONS.has(action) ? action : null;
}

export function normalizeContentTaxonomyReviewState(value = "") {
  const state = boundedText(value, 40).toLowerCase().replace(/[\s-]+/g, "_");
  return REVIEW_STATES.has(state) ? state : null;
}

export function contentTaxonomyMappingReviewState(mapping = {}) {
  if (!mapping || !(mapping.id || mapping.mapping_id)) return "unmapped";
  const status = boundedText(mapping.status || "active", 40).toLowerCase();
  const reviewStatus = boundedText(mapping.review_status || mapping.reviewStatus || (status === "active" ? "approved" : "pending"), 40).toLowerCase();
  if (status === "disabled") return "disabled";
  if (status === "rejected" || reviewStatus === "rejected") return "rejected";
  if (status === "pending" || reviewStatus === "pending") return "needs_review";
  return status === "active" && reviewStatus === "approved" && contentTaxonomyIsComplete(mapping)
    ? "approved"
    : "needs_review";
}

export function contentTaxonomyIsComplete(taxonomy = {}) {
  return Boolean(
    normalizeContentTaxonomyKey(taxonomy.system_key || taxonomy.systemKey)
    && normalizeContentTaxonomyKey(taxonomy.subsystem_key || taxonomy.subsystemKey)
    && normalizeContentTaxonomyKey(taxonomy.topic_key || taxonomy.topicKey)
    && normalizeContentTaxonomyKey(taxonomy.subtopic_key || taxonomy.subtopicKey)
  );
}

function emptyCoverage(exam) {
  return {
    exam_track: exam.id,
    label: exam.label,
    total_questions: 0,
    approved_questions: 0,
    system_classified_questions: 0,
    subsystem_classified_questions: 0,
    topic_classified_questions: 0,
    subtopic_classified_questions: 0,
    complete_questions: 0,
    question_override_count: 0,
    provider_pairs_total: 0,
    provider_pairs_approved: 0,
    provider_pairs_pending: 0,
    provider_pairs_rejected: 0,
    provider_pairs_disabled: 0,
    provider_pairs_unmapped: 0,
  };
}

function mergeMetric(target, metric = {}) {
  const countFields = [
    "total_questions", "approved_questions", "system_classified_questions",
    "subsystem_classified_questions", "topic_classified_questions",
    "subtopic_classified_questions", "complete_questions", "question_override_count",
    "provider_pairs_total", "provider_pairs_approved", "provider_pairs_pending",
    "provider_pairs_rejected", "provider_pairs_disabled", "provider_pairs_unmapped",
  ];
  for (const field of countFields) target[field] += countValue(metric[field]);
}

function percent(numerator, denominator) {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;
}

export function buildContentTaxonomyCoverageReport(metrics = [], examTracks = CONTENT_TAXONOMY_EXAM_TRACKS) {
  const exams = examTracks.map((exam) => typeof exam === "string"
    ? CONTENT_TAXONOMY_EXAM_TRACKS.find((row) => row.id === normalizeContentTaxonomyExamTrack(exam))
    : CONTENT_TAXONOMY_EXAM_TRACKS.find((row) => row.id === normalizeContentTaxonomyExamTrack(exam?.id)))
    .filter(Boolean);
  const uniqueExams = [...new Map(exams.map((exam) => [exam.id, exam])).values()];
  const byExam = new Map(uniqueExams.map((exam) => [exam.id, emptyCoverage(exam)]));

  for (const metric of Array.isArray(metrics) ? metrics : []) {
    const examTrack = normalizeContentTaxonomyExamTrack(metric.exam_track || metric.examTrack);
    if (!byExam.has(examTrack)) continue;
    mergeMetric(byExam.get(examTrack), metric);
  }

  const coverage = [...byExam.values()].map((row) => {
    const unclassifiedQuestions = Math.max(0, row.total_questions - row.complete_questions);
    const unreviewedPairs = Math.max(0, row.provider_pairs_total - row.provider_pairs_approved);
    const issues = [];
    if (!row.total_questions) issues.push("no_questions");
    if (unclassifiedQuestions) issues.push("incomplete_question_taxonomy");
    if (unreviewedPairs) issues.push("unreviewed_provider_pairs");
    const ready = row.total_questions > 0 && unclassifiedQuestions === 0 && unreviewedPairs === 0;
    return {
      ...row,
      unclassified_questions: unclassifiedQuestions,
      unreviewed_provider_pairs: unreviewedPairs,
      question_coverage_percent: percent(row.complete_questions, row.total_questions),
      provider_pair_coverage_percent: percent(row.provider_pairs_approved, row.provider_pairs_total),
      state: ready ? "ready" : row.total_questions ? "incomplete" : "no_content",
      ready,
      issues,
    };
  });

  const withContent = coverage.filter((row) => row.total_questions > 0);
  const totals = coverage.reduce((sum, row) => ({
    total_questions: sum.total_questions + row.total_questions,
    complete_questions: sum.complete_questions + row.complete_questions,
    provider_pairs_total: sum.provider_pairs_total + row.provider_pairs_total,
    provider_pairs_approved: sum.provider_pairs_approved + row.provider_pairs_approved,
  }), { total_questions: 0, complete_questions: 0, provider_pairs_total: 0, provider_pairs_approved: 0 });

  return {
    coverage,
    summary: {
      exam_tracks_total: coverage.length,
      exam_tracks_with_content: withContent.length,
      ready_exam_tracks: coverage.filter((row) => row.ready).length,
      all_exam_tracks_ready: coverage.length > 0 && coverage.every((row) => row.ready),
      all_content_exam_tracks_ready: withContent.length > 0 && withContent.every((row) => row.ready),
      ...totals,
      question_coverage_percent: percent(totals.complete_questions, totals.total_questions),
      provider_pair_coverage_percent: percent(totals.provider_pairs_approved, totals.provider_pairs_total),
    },
  };
}
