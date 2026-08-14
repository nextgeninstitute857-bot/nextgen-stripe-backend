import { resolveAylaExamSupplement } from "./aylamed-exam-supplements.js";

export const AYLA_PUBLICATION_EXAMS = Object.freeze([
  "usmle_step_1", "usmle_step_2_ck", "usmle_step_3", "plab", "amc", "mccqe", "nclex",
]);

export const AYLA_PUBLICATION_RESOURCE_TYPES = Object.freeze([
  "qbank_collection", "vimeo_folder", "video", "book", "book_folder",
  "flashcard_collection", "study_program", "cdm_program",
]);

export const AYLA_PUBLICATION_GROUP_ORDER = Object.freeze([
  "qbank_collection", "vimeo_folder", "book_folder", "flashcard_collection", "study_program", "cdm_program",
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
    reading_folder: "book_folder", library_folder: "book_folder", study_plan: "study_program",
    legacy_cdm: "cdm_program", cdm: "cdm_program", clinical_decision_program: "cdm_program",
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

function compactId(value = "") {
  return key(value).slice(0, 180);
}

function publicationFolderId(resource = {}) {
  return clean(
    resource.folder_id ?? resource.folderId
      ?? resource.collection_id ?? resource.collectionId
      ?? resource.source_folder_id ?? resource.sourceFolderId
      ?? resource.source_namespace ?? resource.sourceNamespace,
    300,
  );
}

function publicationGroupTitle(resource = {}, fallback = "Resource folder") {
  return clean(
    resource.folder_name ?? resource.folderName
      ?? resource.collection_name ?? resource.collectionName
      ?? resource.source_folder_name ?? resource.sourceFolderName
      ?? resource.title ?? resource.name ?? fallback,
    300,
  ) || fallback;
}

const VERIFIED_AUTHORIZATION_STATES = new Set(["authorized", "admin_verified", "licensed", "owned", "approved_registry_collection"]);
const BLOCKED_REVIEW_STATES = new Set(["pending", "pending_review", "needs_review", "unverified", "rejected", "disabled", "quarantined"]);

function optionalNumberFrom(resource = {}, ...keys) {
  for (const name of keys) {
    if (resource[name] === undefined || resource[name] === null || resource[name] === "") continue;
    const value = Number(resource[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function numberFrom(resource = {}, ...keys) {
  return optionalNumberFrom(resource, ...keys) ?? 0;
}

export function aylaPublicationReadinessBlockers(resource = {}, identity = aylaPublicationGroupForResource(resource)) {
  const blockers = [];
  const resourceType = key(resource.type ?? resource.resourceType ?? resource.resource_type);
  const resourceId = clean(resource.id ?? resource.resourceId ?? resource.resource_id, 300) || "resource";
  const status = key(resource.status || "active");
  const authorization = key(resource.authorization_status ?? resource.authorizationStatus);
  const verification = key(resource.verification_status ?? resource.verificationStatus ?? resource.review_status ?? resource.reviewStatus);
  if (["disabled", "deleted", "archived", "quarantined", "rejected"].includes(status)) blockers.push(`${resourceId}: ${status}`);
  if (resource.approved === false) blockers.push(`${resourceId}: approval is required`);
  if (["book", "video"].includes(resourceType) && !VERIFIED_AUTHORIZATION_STATES.has(authorization)) {
    blockers.push(`${resourceId}: source authorization is ${authorization || "unverified"}`);
  } else if (authorization && !VERIFIED_AUTHORIZATION_STATES.has(authorization)) {
    blockers.push(`${resourceId}: source authorization is ${authorization}`);
  }
  if (verification && BLOCKED_REVIEW_STATES.has(verification)) blockers.push(`${resourceId}: review is ${verification}`);
  const requiredMissing = numberFrom(resource,
    "required_media_missing_count", "requiredMediaMissingCount", "blocking_media_missing_count", "blockingMediaMissingCount");
  const ambiguous = numberFrom(resource, "media_ambiguous_count", "mediaAmbiguousCount", "ambiguous_media_count", "ambiguousMediaCount");
  if (requiredMissing > 0) blockers.push(`${resourceId}: ${requiredMissing} required media reference${requiredMissing === 1 ? " is" : "s are"} missing`);
  if (ambiguous > 0) blockers.push(`${resourceId}: ${ambiguous} media reference${ambiguous === 1 ? " is" : "s are"} ambiguous`);
  if (identity?.groupType === "vimeo_folder") {
    const reviewIncomplete = numberFrom(resource, "review_incomplete_count", "reviewIncompleteCount");
    const taxonomyIncomplete = numberFrom(resource, "taxonomy_incomplete_count", "taxonomyIncompleteCount");
    const missingFromFolder = numberFrom(resource, "missing_from_folder_count", "missingFromFolderCount");
    if (reviewIncomplete > 0) blockers.push(`${resourceId}: ${reviewIncomplete} video${reviewIncomplete === 1 ? " is" : "s are"} not approved`);
    if (taxonomyIncomplete > 0) blockers.push(`${resourceId}: ${taxonomyIncomplete} video${taxonomyIncomplete === 1 ? " is" : "s are"} missing complete taxonomy`);
    if (missingFromFolder > 0) blockers.push(`${resourceId}: ${missingFromFolder} reviewed video${missingFromFolder === 1 ? " is" : "s are"} no longer present in the source folder`);
  }
  if (identity?.groupType === "qbank_collection") {
    const questions = numberFrom(resource, "question_count", "questionCount");
    const valid = optionalNumberFrom(resource, "valid_question_count", "validQuestionCount", "valid_count", "validCount") ?? questions;
    const taxonomy = numberFrom(resource, "taxonomy_complete_count", "taxonomyCompleteCount");
    if (!questions) blockers.push("Question count is unavailable");
    if (questions && valid !== questions) blockers.push(`Valid questions ${valid}/${questions}`);
    if (questions && taxonomy !== questions) blockers.push(`Taxonomy ${taxonomy}/${questions}`);
    if (!["approved", "published"].includes(status)) blockers.push(`Collection status is ${status || "draft"}`);
  }
  if (identity?.groupType === "study_program") {
    const blocks = numberFrom(resource, "block_count", "blockCount");
    const sourceBank = clean(resource.source_bank_collection_key ?? resource.sourceBankCollectionKey);
    if (!blocks) blockers.push("Study-program block count is unavailable");
    if (!sourceBank) blockers.push("Source QBank reference is unavailable");
  }
  if (identity?.groupType === "cdm_program") {
    const cases = numberFrom(resource, "case_count", "caseCount");
    const steps = numberFrom(resource, "step_count", "stepCount");
    if (!cases) blockers.push("CDM case count is unavailable");
    if (!steps) blockers.push("CDM step count is unavailable");
  }
  return [...new Set(blockers)];
}

export function aylaPublicationGroupForResource(resource = {}) {
  const resourceType = key(resource.type ?? resource.resourceType ?? resource.resource_type);
  const resourceId = clean(resource.id ?? resource.resourceId ?? resource.resource_id, 300);
  const folderId = publicationFolderId(resource);
  const sourceLabel = clean(resource.provider ?? resource.source_provider ?? resource.sourceProvider, 180);
  const fallbackScope = compactId(sourceLabel || publicationGroupTitle(resource, "unfiled"));
  if (resourceType === "book") {
    const groupId = folderId || `unfiled-books-${fallbackScope || compactId(resourceId)}`;
    return { groupType: "book_folder", groupId, title: publicationGroupTitle(resource, sourceLabel || "Book folder") };
  }
  if (resourceType === "flashcard_collection") {
    const groupId = folderId || `unfiled-flashcards-${fallbackScope || compactId(resourceId)}`;
    return { groupType: "flashcard_collection", groupId, title: publicationGroupTitle(resource, sourceLabel || "Flashcard folder") };
  }
  if (resourceType === "video") {
    const groupId = folderId || `unfiled-vimeo-${fallbackScope || compactId(resourceId)}`;
    return { groupType: "vimeo_folder", groupId, title: publicationGroupTitle(resource, sourceLabel || "Vimeo folder") };
  }
  if (resourceType === "cdm_program") {
    const groupId = folderId || `legacy-cdm-${fallbackScope || "ace"}`;
    return { groupType: "cdm_program", groupId, title: publicationGroupTitle(resource, sourceLabel ? `${sourceLabel} Legacy CDM` : "ACE Legacy CDM") };
  }
  if (AYLA_PUBLICATION_GROUP_ORDER.includes(resourceType) && resourceId) {
    return { groupType: resourceType, groupId: resourceId, title: publicationGroupTitle(resource, resourceId) };
  }
  return null;
}

function configuredPublicationState(examTrackId, groupType, groupId, controls = []) {
  const control = rows(controls).map((row) => {
    try { return normalizeAylaResourcePublicationControl(row, row); } catch { return null; }
  }).filter(Boolean).find((row) => row.examTrackId === examTrackId
    && row.resourceType === groupType && row.resourceId === groupId);
  return { enabled: control ? control.enabled : true, inherited: !control, control: control || null };
}

export function buildAylaCompactPublicationGroups({ exams = [], availableResources = [], resourceControls = [] } = {}) {
  const examById = new Map(rows(exams).map((exam) => [key(exam.examTrackId ?? exam.exam_track_id), exam]));
  const groups = new Map();
  for (const resource of rows(availableResources)) {
    const examTrackId = key(resource.exam_track_id ?? resource.examTrackId ?? resource.exam_track);
    const identity = aylaPublicationGroupForResource(resource);
    if (!examTrackId || !identity) continue;
    const groupKey = `${examTrackId}:${identity.groupType}:${identity.groupId}`;
    const existing = groups.get(groupKey) || {
      id: groupKey,
      exam_track_id: examTrackId,
      type: identity.groupType,
      resource_id: identity.groupId,
      title: identity.title,
      resources: [],
      resource_count: 0,
      question_count: 0,
      video_count: 0,
      declared_video_count: 0,
      case_count: 0,
      step_count: 0,
      block_count: 0,
      supplemental: resource.supplemental === true,
      source_exam_track_id: key(resource.source_exam_track_id ?? resource.sourceExamTrackId ?? examTrackId),
      readiness_blockers: [],
    };
    if (!existing.resources.some((row) => row.id === String(resource.id || "") && row.type === key(resource.type))) {
      existing.resources.push({
        id: String(resource.id || ""),
        type: key(resource.type),
        title: clean(resource.title || resource.id, 300),
        status: clean(resource.status || "active", 80),
      });
    }
    existing.resource_count = existing.resources.length;
    existing.question_count += Number(resource.question_count || 0);
    if (resource.type === "vimeo_folder") existing.declared_video_count += Number(resource.video_count || 0);
    if (resource.type === "video") existing.video_count += 1;
    existing.case_count += Number(resource.case_count || 0);
    existing.step_count += Number(resource.step_count || 0);
    existing.block_count += Number(resource.block_count || 0);
    existing.readiness_blockers.push(...aylaPublicationReadinessBlockers(resource, identity));
    groups.set(groupKey, existing);
  }
  return [...groups.values()].map((group) => {
    const publication = configuredPublicationState(group.exam_track_id, group.type, group.resource_id, resourceControls);
    const memberStates = group.resources.map((resource) => configuredPublicationState(
      group.exam_track_id,
      resource.type,
      resource.id,
      resourceControls,
    ).enabled);
    const mixed = new Set(memberStates).size > 1;
    const examEnabled = examById.get(group.exam_track_id)?.enabled === true;
    const readinessBlockers = [...new Set(group.readiness_blockers)];
    return {
      ...group,
      video_count: group.video_count || group.declared_video_count,
      declared_video_count: undefined,
      resources: group.resources.sort((left, right) => left.title.localeCompare(right.title)),
      readiness_blockers: readinessBlockers,
      ready: readinessBlockers.length === 0,
      configured_state: mixed ? "mixed" : publication.enabled ? "published" : "unpublished",
      configured_enabled: publication.enabled,
      inherited: publication.inherited,
      mixed_state: mixed,
      effective_student_access: examEnabled && publication.enabled && !mixed,
      effective_state: mixed ? "mixed_review_required" : examEnabled && publication.enabled ? "available" : "unavailable",
      control_id: publication.control?.id || null,
    };
  }).sort((left, right) => {
    const examOrder = AYLA_PUBLICATION_EXAMS.indexOf(left.exam_track_id) - AYLA_PUBLICATION_EXAMS.indexOf(right.exam_track_id);
    if (examOrder) return examOrder;
    const typeOrder = AYLA_PUBLICATION_GROUP_ORDER.indexOf(left.type) - AYLA_PUBLICATION_GROUP_ORDER.indexOf(right.type);
    return typeOrder || left.title.localeCompare(right.title);
  });
}

export function assertAylaPublicationGroupMutationAllowed(group = {}, enabled = false) {
  if (!enabled) return true;
  if (!group?.id) {
    throw Object.assign(new Error("The requested publication group is unavailable for readiness validation"), {
      statusCode: 409,
      code: "PUBLICATION_GROUP_UNAVAILABLE",
    });
  }
  if (group.mixed_state) {
    throw Object.assign(new Error("Mixed — review required. Existing child publication states were preserved."), {
      statusCode: 409,
      code: "PUBLICATION_GROUP_MIXED",
    });
  }
  if (group.ready === false || rows(group.readiness_blockers).length) {
    const blockers = rows(group.readiness_blockers);
    throw Object.assign(new Error(blockers.join("; ") || "This publication group has not passed its readiness gate"), {
      statusCode: 409,
      code: "PUBLICATION_GROUP_NOT_READY",
      blockers,
    });
  }
  return true;
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
