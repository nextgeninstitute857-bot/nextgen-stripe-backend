const SUPPLEMENTAL_DESTINATIONS = Object.freeze([
  "content_hub",
  "qbank",
  "personal_tutor",
  "roadmap",
  "revision",
]);

const SCORING_DESTINATIONS = new Set([
  "diagnostic", "assessment", "readiness", "scoring", "weakness", "attempt",
]);

export const AYLA_EXAM_SUPPLEMENTAL_SOURCES = Object.freeze({
  mccqe: Object.freeze([
    Object.freeze({
      source_exam_track: "usmle_step_2_ck",
      label: "USMLE Step 2 CK Supplemental",
      resource_types: Object.freeze(["qbank_collection", "vimeo_folder", "video"]),
      allowed_destinations: SUPPLEMENTAL_DESTINATIONS,
      scoring_policy: "excluded_from_mccqe_readiness_and_mastery",
    }),
  ]),
});

function key(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = {
    usmle_step_2: "usmle_step_2_ck",
    step_2: "usmle_step_2_ck",
    step_2_ck: "usmle_step_2_ck",
    mccqe_1: "mccqe",
    mccqe_part_i: "mccqe",
  };
  return aliases[normalized] || normalized;
}

export function resolveAylaExamSupplement({
  examTrack,
  sourceExamTrack,
  resourceType,
  destination = "content_hub",
} = {}) {
  const exam = key(examTrack);
  const sourceExam = key(sourceExamTrack || examTrack);
  const type = key(resourceType);
  const destinationKey = key(destination);
  if (exam === sourceExam) {
    return { supplemental: false, allowed: true, scoring_allowed: true, policy: null };
  }
  const policy = (AYLA_EXAM_SUPPLEMENTAL_SOURCES[exam] || []).find((row) =>
    row.source_exam_track === sourceExam && row.resource_types.includes(type));
  if (!policy) {
    return { supplemental: false, allowed: false, scoring_allowed: false, policy: null };
  }
  const scoringAllowed = !SCORING_DESTINATIONS.has(destinationKey);
  return {
    supplemental: true,
    allowed: scoringAllowed && policy.allowed_destinations.includes(destinationKey),
    scoring_allowed: false,
    policy,
  };
}

export function listAylaExamSupplements(examTrack = "") {
  return [...(AYLA_EXAM_SUPPLEMENTAL_SOURCES[key(examTrack)] || [])];
}
