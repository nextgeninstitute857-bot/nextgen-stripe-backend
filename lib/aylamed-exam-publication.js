import { resolveAylaExamSupplement } from "./aylamed-exam-supplements.js";

export const AYLA_PUBLICATION_EXAMS = Object.freeze([
  "usmle_step_1", "usmle_step_2_ck", "usmle_step_3", "plab", "amc", "mccqe", "nclex",
]);

export const AYLA_PUBLICATION_RESOURCE_TYPES = Object.freeze([
  "qbank_collection", "vimeo_folder", "video", "book", "flashcard_collection",
]);

export const AYLA_PUBLICATION_DESTINATIONS = Object.freeze([
  "content_hub", "qbank", "personal_tutor", "roadmap", "revision",
  "diagnostic", "assessment", "readiness", "scoring", "weakness", "attempt",
]);

const HISTORY_DESTINATIONS = new Set(["history", "progress", "completed_assignment"]);
const DEFAULT_ENABLED_EXAMS = new Set(["usmle_step_1"]);

function key(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = {
    usmle_step_2: "usmle_step_2_ck", step_2: "usmle_step_2_ck", step_2_ck: "usmle_step_2_ck",
    mccqe_1: "mccqe", mccqe_part_i: "mccqe", nclex_rn: "nclex",
    reading: "book", revision_sheet: "book", vimeo_video: "video", video_transcript: "video",
    flashcard: "flashcard_collection", internal_mcq: "qbank_collection", qbank: "qbank_collection",
    aylamed_qbank: "qbank", aylamed_content_hub: "content_hub", aylamed_roadmap: "roadmap",
  };
  return aliases[normalized] || normalized;
}

function bool(value, fallback = true) {
  if (value === true || value === false) return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function clean(value = "", maximum = 240) {
  return String(value ?? "").trim().slice(0, maximum);
}

function rows(value) {
  return Array.isArray(value) ? value : Object.values(value || {});
}

function defaultExamPublicationEnabled(examTrackId) {
  return DEFAULT_ENABLED_EXAMS.has(examTrackId);
}

export function normalizeAylaExamPublicationControl(input = {}, existing = {}) {
  const examTrackId = key(input.examTrackId ?? input.exam_track_id ?? input.examTrack ?? existing.examTrackId);
  if (!AYLA_PUBLICATION_EXAMS.includes(examTrackId)) {
    throw Object.assign(new Error("A supported exam track is required"), { statusCode: 400 });
  }
  return {
    ...existing,
    id: `AYLA-EXAM-PUBLICATION-${examTrackId}`,
    type: "exam_publication_control",
    examTrackId,
    enabled: bool(input.enabled ?? input.published ?? existing.enabled, defaultExamPublicationEnabled(examTrackId)),
    note: clean(input.note ?? existing.note, 500),
  };
}

export function normalizeAylaResourcePublicationControl(input = {}, existing = {}) {
  const examTrackId = key(input.examTrackId ?? input.exam_track_id ?? input.examTrack ?? existing.examTrackId);
  const resourceType = key(input.resourceType ?? input.resource_type ?? existing.resourceType);
  const resourceId = clean(input.resourceId ?? input.resource_id ?? existing.resourceId, 300);
  if (!AYLA_PUBLICATION_EXAMS.includes(examTrackId)) {
    throw Object.assign(new Error("A supported exam track is required"), { statusCode: 400 });
  }
  if (!AYLA_PUBLICATION_RESOURCE_TYPES.includes(resourceType)) {
    throw Object.assign(new Error("A supported resource type is required"), { statusCode: 400 });
  }
  if (!resourceId) throw Object.assign(new Error("resource_id is required"), { statusCode: 400 });
  const destinationInput = input.destinations ?? existing.destinations ?? {};
  const destinations = Object.fromEntries(AYLA_PUBLICATION_DESTINATIONS.map((destination) => [
    destination,
    bool(destinationInput[destination], true),
  ]));
  return {
    ...existing,
    id: `AYLA-RESOURCE-PUBLICATION-${examTrackId}-${resourceType}-${resourceId}`,
    type: "resource_publication_control",
    examTrackId,
    resourceType,
    resourceId,
    sourceExamTrackId: key(input.sourceExamTrackId ?? input.source_exam_track_id ?? existing.sourceExamTrackId ?? examTrackId),
    enabled: bool(input.enabled ?? input.published ?? existing.enabled, true),
    destinations,
    note: clean(input.note ?? existing.note, 500),
  };
}

export function resolveAylaExamPublication({
  examTrack,
  sourceExamTrack,
  resourceType,
  resourceId,
  destination = "content_hub",
  examControls = [],
  resourceControls = [],
} = {}) {
  const exam = key(examTrack);
  const sourceExam = key(sourceExamTrack || examTrack);
  const type = key(resourceType);
  const id = clean(resourceId, 300);
  const destinationKey = key(destination);
  if (HISTORY_DESTINATIONS.has(destinationKey)) {
    return { allowed: true, reason: "history_preserved", exam_enabled: true, resource_enabled: true, supplemental: false, scoring_allowed: false };
  }
  if (!AYLA_PUBLICATION_EXAMS.includes(exam)) {
    return { allowed: false, reason: "unsupported_exam", exam_enabled: false, resource_enabled: false, supplemental: false, scoring_allowed: false };
  }
  const master = rows(examControls).map((row) => {
    try { return normalizeAylaExamPublicationControl(row, row); } catch { return null; }
  }).filter(Boolean).find((row) => row.examTrackId === exam);
  const examEnabled = master ? master.enabled : defaultExamPublicationEnabled(exam);
  if (!examEnabled) {
    return { allowed: false, reason: "exam_unpublished", exam_enabled: false, resource_enabled: true, supplemental: sourceExam !== exam, scoring_allowed: false };
  }
  const supplement = resolveAylaExamSupplement({ examTrack: exam, sourceExamTrack: sourceExam, resourceType: type, destination: destinationKey });
  if (!supplement.allowed) {
    return { allowed: false, reason: supplement.supplemental ? "supplement_excluded_from_destination" : "cross_exam_resource_blocked", exam_enabled: true, resource_enabled: false, supplemental: supplement.supplemental, scoring_allowed: supplement.scoring_allowed };
  }
  const control = rows(resourceControls).map((row) => {
    try { return normalizeAylaResourcePublicationControl(row, row); } catch { return null; }
  }).filter(Boolean).find((row) => row.examTrackId === exam && row.resourceType === type && row.resourceId === id);
  const resourceEnabled = control ? control.enabled && control.destinations[destinationKey] !== false : true;
  return {
    allowed: resourceEnabled,
    reason: resourceEnabled ? (supplement.supplemental ? "supplement_enabled" : "published") : "resource_unpublished",
    exam_enabled: true,
    resource_enabled: resourceEnabled,
    supplemental: supplement.supplemental,
    scoring_allowed: supplement.supplemental ? false : true,
    control_id: control?.id || null,
  };
}

export function buildAylaPublicationControlPanel({ examControls = [], resourceControls = [] } = {}) {
  const normalizedExamControls = AYLA_PUBLICATION_EXAMS.map((examTrackId) => {
    const row = rows(examControls).find((candidate) => key(candidate.examTrackId || candidate.exam_track_id) === examTrackId);
    return normalizeAylaExamPublicationControl({ examTrackId, ...(row || {}) }, row || {});
  });
  const normalizedResources = rows(resourceControls).map((row) => {
    try { return normalizeAylaResourcePublicationControl(row, row); } catch { return null; }
  }).filter(Boolean);
  return {
    exams: normalizedExamControls,
    resources: normalizedResources,
    rules: {
      exam_master_overrides_resources: true,
      resource_states_preserved_while_exam_off: true,
      progress_and_history_preserved: true,
      mccqe_step2_supplement_excluded_from_scoring: true,
    },
  };
}
