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
  const start = server.indexOf('app.get("/api/ayla/admin/resources/vimeo-catalog/folder-publication"');
  const end = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/review"', start);
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

test("all mapped Content Hub videos have one reversible all-students publication control", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf("function aylaMappedVimeoDraftsForGlobalPublication");
  const end = server.indexOf("const AYLA_GLOBAL_SHARED_RESOURCE_PUBLICATION", start);
  assert.ok(start >= 0 && end > start);
  const routes = server.slice(start, end);
  assert.match(routes, /global-publication/);
  assert.match(routes, /scope: "all_students"/);
  assert.match(routes, /expected_mapped_count/);
  assert.match(routes, /\$\{action\.toUpperCase\(\)\}_ALL_MAPPED_VIMEO_\$\{expectedMappedCount\}/);
  assert.match(routes, /deliveryDestinations: \[\]/);
  assert.match(routes, /mappings_preserved: true/);
  assert.match(routes, /progress_preserved: true/);
  assert.match(routes, /schedule_history_preserved: true/);
  assert.match(routes, /classifiers_started: 0/);
  assert.doesNotMatch(routes, /aylaQueueVimeoCatalogClassification/);
  assert.doesNotMatch(routes, /ngContentBackgroundQueue\.enqueue/);
  assert.doesNotMatch(routes, /deleteAyla|\.delete\(|TRUNCATE\s/i);
});

test("the same reversible all-students control includes only the two existing testing books", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /AYLA_GLOBAL_SHARED_RESOURCE_PUBLICATION/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/resources\/global-publication\/:kind"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/resources\/global-publication\/:kind"/);
  assert.match(server, /student_owned_resources_changed: 0/);
  assert.match(server, /private_pilot_resources_changed: result\.privatePilotResourcesChanged/);
  assert.match(server, /all_approved_readings/);
  assert.match(server, /all_approved_flashcards/);
  assert.match(server, /AYLA-PILOT-BOOK-FA2025-CARDIO-304-309/);
  assert.match(server, /AYLA-PILOT-BOOK-PATHOMA-CARDIAC-80-84/);
  assert.match(server, /testing_books_linked_to_same_action: true/);
  assert.match(server, /aylaApplyGlobalTestingBookPublication\(db, action, actor\)/);
  assert.match(server, /accessScope: publish \? "all_students" : "private_pilot"/);
  assert.match(server, /pilotOnly: !publish/);
  assert.match(server, /mappings_preserved: true/);
  assert.match(server, /progress_preserved: true/);
  assert.match(server, /schedule_history_preserved: true/);
});

test("globally published mapped videos remain visible to the permanent pilot testing account", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const visibility = server.slice(
    server.indexOf("function aylaStep1PilotVimeoVisibleToStudent"),
    server.indexOf("const AYLA_INTERNAL_REVIEW_EMAIL_HASH"),
  );
  assert.match(visibility, /global_student_publication/);
  assert.match(visibility, /globalStudentPublication/);
  assert.match(visibility, /globalStudentPublication \|\| aylaStep1PilotVimeoSourceMatches/);
});
