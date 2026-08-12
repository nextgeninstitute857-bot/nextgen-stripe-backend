import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAylaPublicationControlPanel,
  normalizeAylaExamPublicationControl,
  normalizeAylaResourcePublicationControl,
  resolveAylaExamPublication,
} from "../lib/aylamed-exam-publication.js";

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
