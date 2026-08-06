import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { approveVimeoCatalogDraft } from "../lib/vimeo-library-manifest.js";

test("owner-reviewed offline mappings can become student-scoped active resources", () => {
  const fingerprint = "f".repeat(64);
  const draft = {
    id: "draft-1",
    revision: 4,
    vimeoId: "123456",
    sourceTitle: "Cardiac physiology",
    sourceNamespace: "vimeo_folder:30014230",
    folderId: "30014230",
    folderMembershipStatus: "present_in_folder",
    examTrackId: "usmle_step_1",
    mappingImport: { fingerprint },
    classification: {
      medicalSystem: "Cardiovascular",
      medicalSubsystem: "Cardiac physiology",
      canonicalTopic: "Cardiac cycle",
      subtopic: "Pressure-volume loops",
      confidencePercent: 99,
      approvalReadiness: "ready_for_owner_approval",
      importedMappingFingerprint: fingerprint,
    },
  };
  const approved = approveVimeoCatalogDraft(draft, {
    expectedRevision: 4,
    overrides: { resourceId: "scoped-resource", ownerStudentId: "student-1" },
  });
  assert.equal(approved.resource.id, "scoped-resource");
  assert.equal(approved.resource.ownerStudentId, "student-1");
  assert.equal(approved.resource.approved, true);
  assert.equal(approved.resource.status, "active");
  assert.deepEqual(approved.resource.deliveryDestinations, ["aylamed_content_hub", "aylamed_roadmap"]);
  assert.equal(approved.resource.classificationEvidence.ownerReviewedOffline, true);
});

test("folder publication is explicit, testing-student scoped, reversible, and classifier-free", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf("function aylaManualVimeoFolderPublicationState");
  const end = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/review"');
  assert.ok(start >= 0 && end > start);
  const routes = server.slice(start, end);
  assert.match(routes, /folder-publication/);
  assert.match(server, /AYLA_INTERNAL_REVIEW_EMAIL_HASH/);
  assert.match(routes, /ownerStudentId: target\.student\.id/);
  assert.match(routes, /action === "publish"/);
  assert.match(routes, /status: "disabled"/);
  assert.match(routes, /mappings_preserved: true/);
  assert.match(routes, /classifiers_started: 0/);
  assert.doesNotMatch(routes, /aylaQueueVimeoCatalogClassification/);
  assert.doesNotMatch(routes, /ngContentBackgroundQueue\.enqueue/);
  assert.doesNotMatch(routes, /deleteAyla|\.delete\(|TRUNCATE\s/i);
});
