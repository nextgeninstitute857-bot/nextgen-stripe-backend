import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAylaPublicationGroupMutationAllowed,
  aylaPublicationGroupForResource,
  aylaPublicationReadinessBlockers,
  buildAylaCompactPublicationGroups,
  buildAylaPublicationControlPanel,
  normalizeAylaExamPublicationControl,
  normalizeAylaResourcePublicationControl,
  resolveAylaExamPublication,
} from "../lib/aylamed-exam-publication.js";

test("book, video and flashcard children collapse to named folder controls", () => {
  assert.deepEqual(aylaPublicationGroupForResource({ type: "book", id: "book-1", folder_id: "plab-library", folder_name: "PLAB Library" }), {
    groupType: "book_folder", groupId: "plab-library", title: "PLAB Library",
  });
  assert.equal(aylaPublicationGroupForResource({ type: "video", id: "video-1", folder_id: "step2-videos" }).groupType, "vimeo_folder");
  assert.equal(aylaPublicationGroupForResource({ type: "flashcard_collection", id: "card-1", collection_id: "step2-flash" }).groupId, "step2-flash");
  assert.equal(aylaPublicationGroupForResource({ type: "cdm_program", id: "case-1", provider: "ACE" }).groupId, "legacy-cdm-ace");
});

test("compact groups expose configured and effective state without flattening child details", () => {
  const groups = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "usmle_step_2_ck", enabled: false }],
    availableResources: [
      { id: "book-1", type: "book", exam_track_id: "usmle_step_2_ck", title: "Volume 1", folder_id: "step2-library", folder_name: "Step 2 Library", status: "approved" },
      { id: "book-2", type: "book", exam_track_id: "usmle_step_2_ck", title: "Volume 2", folder_id: "step2-library", folder_name: "Step 2 Library", status: "approved" },
      { id: "uworld-step2", type: "qbank_collection", exam_track_id: "usmle_step_2_ck", title: "UWorld Step 2 CK March 2026", status: "approved", question_count: 4085, taxonomy_complete_count: 4085 },
    ],
  });
  assert.equal(groups.length, 2);
  const books = groups.find((group) => group.type === "book_folder");
  assert.equal(books.resource_count, 2);
  assert.equal(books.configured_state, "published");
  assert.equal(books.effective_student_access, false);
  assert.equal(groups.find((group) => group.type === "qbank_collection").ready, true);
});

test("question-bank collections collapse by bank name, retain folders, and exclude NBMEs and internal test containers", () => {
  const groups = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "usmle_step_2_ck", enabled: true }],
    availableResources: [
      {
        id: "uworld-step2-main", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
        title: "UWorld Step 2 main", source_provider: "UWorld", source_namespace: "step2/main",
        status: "approved", question_count: 4000, valid_question_count: 4000,
        taxonomy_complete_count: 4000, delivery_media_ready_count: 3990,
      },
      {
        id: "uworld-step2-sim", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
        title: "UWorld Step 2 simulation", source_provider: "UWorld", source_namespace: "step2/simulations",
        status: "draft", question_count: 85, valid_question_count: 85,
        taxonomy_complete_count: 85, delivery_media_ready_count: 85, publication_default_enabled: false,
      },
      {
        id: "nbme-9", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
        title: "NBME 9", source_provider: "NBME", delivery_channel: "nbme",
        status: "approved", question_count: 200, valid_question_count: 200,
        taxonomy_complete_count: 200, delivery_media_ready_count: 200,
      },
      {
        id: "pilot-preview", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
        title: "Internal preview", source_provider: "Internal", delivery_channel: "internal_testing",
        status: "approved", question_count: 28, valid_question_count: 28,
        taxonomy_complete_count: 0, delivery_media_ready_count: 28,
      },
      {
        id: "simulation-form", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
        title: "Simulation form 1", source_provider: "UWorld", delivery_channel: "assessment",
        status: "approved", question_count: 160, valid_question_count: 160,
        taxonomy_complete_count: 0, delivery_media_ready_count: 160,
      },
    ],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "UWorld");
  assert.equal(groups[0].resource_count, 2);
  assert.equal(groups[0].folders.length, 2);
  assert.equal(groups[0].question_count, 4085);
  assert.equal(groups[0].excluded_question_count, 10);
  assert.equal(groups[0].configured_state, "mixed");
});

test("a complete private AMBOSS collection is ready for the bank Publish action", () => {
  const [group] = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "usmle_step_2_ck", enabled: false }],
    availableResources: [{
      id: "amboss-step2", type: "qbank_collection", exam_track_id: "usmle_step_2_ck",
      title: "AMBOSS Step 2 CK", source_provider: "AMBOSS", source_namespace: "amboss/step2/2025",
      status: "draft", question_count: 3501, valid_question_count: 3501,
      taxonomy_complete_count: 3501, delivery_media_ready_count: 3501, publication_default_enabled: false,
    }],
  });
  assert.equal(group.title, "AMBOSS");
  assert.equal(group.ready, true);
  assert.equal(group.configured_state, "unpublished");
  assert.equal(assertAylaPublicationGroupMutationAllowed(group, true), true);
});

test("mixed child controls are preserved and surfaced for review", () => {
  const groups = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "plab", enabled: true }],
    availableResources: [
      { id: "book-1", type: "book", exam_track_id: "plab", title: "Book 1", folder_id: "plab-books", status: "approved" },
      { id: "book-2", type: "book", exam_track_id: "plab", title: "Book 2", folder_id: "plab-books", status: "approved" },
    ],
    resourceControls: [{ examTrackId: "plab", resourceType: "book", resourceId: "book-2", enabled: false }],
  });
  assert.equal(groups[0].configured_state, "mixed");
  assert.equal(groups[0].effective_state, "mixed_review_required");
  assert.equal(groups[0].effective_student_access, false);
});

test("a deliberate folder switch does not become mixed merely because legacy children remain enabled", () => {
  const groups = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "plab", enabled: true }],
    availableResources: [
      { id: "book-1", type: "book", exam_track_id: "plab", title: "Book 1", folder_id: "plab-books", status: "approved", authorization_status: "licensed" },
      { id: "book-2", type: "book", exam_track_id: "plab", title: "Book 2", folder_id: "plab-books", status: "approved", authorization_status: "licensed" },
    ],
    resourceControls: [{ examTrackId: "plab", resourceType: "book_folder", resourceId: "plab-books", enabled: false }],
  });
  assert.equal(groups[0].configured_state, "unpublished");
  assert.equal(groups[0].mixed_state, false);
  assert.equal(groups[0].effective_student_access, false);
});

test("readiness gates fail closed for rights, review, taxonomy and missing source-folder evidence", () => {
  const rights = aylaPublicationReadinessBlockers({
    id: "plab-book", type: "book", folder_id: "plab-books", status: "approved", authorization_status: "unverified",
  });
  assert.match(rights.join("; "), /source authorization is unverified/);
  const video = buildAylaCompactPublicationGroups({
    exams: [{ examTrackId: "usmle_step_2_ck", enabled: false }],
    availableResources: [{
      id: "step2-videos", type: "vimeo_folder", exam_track_id: "usmle_step_2_ck", status: "active",
      video_count: 918, review_incomplete_count: 1, taxonomy_incomplete_count: 2, missing_from_folder_count: 3,
    }],
  })[0];
  assert.equal(video.ready, false);
  assert.throws(
    () => assertAylaPublicationGroupMutationAllowed(video, true),
    (error) => error.code === "PUBLICATION_GROUP_NOT_READY" && error.statusCode === 409,
  );
  assert.equal(assertAylaPublicationGroupMutationAllowed(video, false), true);
});

test("exam master publication overrides resources without deleting their state", () => {
  const exam = normalizeAylaExamPublicationControl({ examTrackId: "amc", enabled: false });
  const resource = normalizeAylaResourcePublicationControl({
    examTrackId: "amc",
    resourceType: "book",
    resourceId: "amc-handbook",
    enabled: true,
    destinations: { content_hub: true, roadmap: false },
  });
  const off = resolveAylaExamPublication({
    examTrack: "amc", sourceExamTrack: "amc", resourceType: "book", resourceId: "amc-handbook",
    destination: "content_hub", examControls: [exam], resourceControls: [resource],
  });
  assert.equal(off.allowed, false);
  assert.equal(off.reason, "exam_unpublished");
  assert.equal(resource.enabled, true);
  assert.equal(resource.destinations.roadmap, false);

  const on = resolveAylaExamPublication({
    examTrack: "amc", sourceExamTrack: "amc", resourceType: "book", resourceId: "amc-handbook",
    destination: "roadmap", examControls: [{ ...exam, enabled: true }], resourceControls: [resource],
  });
  assert.equal(on.allowed, false);
  assert.equal(on.reason, "resource_unpublished");
});

test("progress and history remain readable while an exam is unpublished", () => {
  const result = resolveAylaExamPublication({
    examTrack: "nclex", sourceExamTrack: "nclex", resourceType: "book", resourceId: "b1",
    destination: "history", examControls: [{ examTrackId: "nclex", enabled: false }],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "history_preserved");
});

test("Step 2 material is supplemental for MCCQE and never enters readiness scoring", () => {
  const tutor = resolveAylaExamPublication({
    examTrack: "mccqe", sourceExamTrack: "usmle_step_2_ck", resourceType: "vimeo_folder",
    resourceId: "step2-videos", destination: "personal_tutor",
    examControls: [{ examTrackId: "mccqe", enabled: true }],
  });
  assert.equal(tutor.allowed, true);
  assert.equal(tutor.supplemental, true);
  assert.equal(tutor.scoring_allowed, false);

  const qbank = resolveAylaExamPublication({
    examTrack: "mccqe", sourceExamTrack: "usmle_step_2_ck", resourceType: "qbank_collection",
    resourceId: "amboss-step2", destination: "qbank",
    examControls: [{ examTrackId: "mccqe", enabled: true }],
  });
  assert.equal(qbank.allowed, true);
  assert.equal(qbank.supplemental, true);
  assert.equal(qbank.scoring_allowed, false);

  for (const destination of ["diagnostic", "assessment", "readiness", "scoring", "weakness", "attempt"]) {
    const result = resolveAylaExamPublication({
      examTrack: "mccqe", sourceExamTrack: "usmle_step_2_ck", resourceType: "vimeo_folder",
      resourceId: "step2-videos", destination,
      examControls: [{ examTrackId: "mccqe", enabled: true }],
    });
    assert.equal(result.allowed, false, destination);
    assert.equal(result.scoring_allowed, false, destination);
  }
});

test("the control panel always supplies a master switch for every exam", () => {
  const panel = buildAylaPublicationControlPanel();
  assert.equal(panel.exams.length, 7);
  assert.deepEqual(panel.exams.filter((exam) => exam.enabled).map((exam) => exam.examTrackId), ["usmle_step_1"]);
  assert.equal(panel.rules.exam_master_overrides_resources, true);
  assert.equal(panel.rules.mccqe_step2_supplement_excluded_from_scoring, true);
});

test("new exam sites remain private until their master switch is explicitly enabled", () => {
  for (const examTrack of ["usmle_step_2_ck", "usmle_step_3", "mccqe", "amc", "nclex", "plab"]) {
    const result = resolveAylaExamPublication({
      examTrack,
      sourceExamTrack: examTrack,
      resourceType: "qbank_collection",
      resourceId: "approved-bank",
      destination: "qbank",
    });
    assert.equal(result.allowed, false, examTrack);
    assert.equal(result.reason, "exam_unpublished", examTrack);
  }
});
