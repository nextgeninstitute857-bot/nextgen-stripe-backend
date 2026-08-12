import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyAylaVimeoMappings,
  validateAylaVimeoMappingImport,
} from "../lib/aylamed-vimeo-mapping-import.js";

const mappings = Array.from({ length: 491 }, (_, index) => ({
  vimeo_id: String(1000 + index), source_title: `Lecture ${index}`,
  proposed_exam: "USMLE Step 1", proposed_system: "Renal",
  proposed_subsystem: "Physiology", proposed_topic: `Topic ${index}`,
  proposed_subtopic: `Subtopic ${index}`, confidence_percent: 98,
  decision: "reviewed_offline", production_action: "none",
}));
const drafts = mappings.map((row, index) => ({
  id: `draft-${index}`, vimeoId: row.vimeo_id, sourceTitle: row.source_title,
  folderId: "29973623", status: "classification_failed", reviewStatus: "pending",
  approved: false, revision: 3,
}));

test("dry-run validates all 491 mappings without writes", () => {
  const result = validateAylaVimeoMappingImport({ mappings, drafts });
  assert.equal(result.valid, true);
  assert.equal(result.mapping_count, 491);
  assert.equal(result.unique_vimeo_ids, 491);
  assert.equal(result.safeguards.creates_active_resources, false);
});

test("dry-run follows the complete live catalogue size instead of a fixed count", () => {
  const expandedMappings = [...mappings, {
    ...mappings[0], vimeo_id: "2000", source_title: "New future lecture",
  }];
  const expandedDrafts = [...drafts, {
    ...drafts[0], id: "draft-new", vimeoId: "2000", sourceTitle: "New future lecture",
  }];
  const result = validateAylaVimeoMappingImport({ mappings: expandedMappings, drafts: expandedDrafts });
  assert.equal(result.valid, true);
  assert.equal(result.expected_count, 492);
  assert.equal(result.mapping_count, 492);
});

test("dry-run scopes a multi-folder import without requiring existing B&B drafts", () => {
  const selected = mappings.slice(0, 2).map((row, index) => ({
    ...row,
    source_folder_id: index ? "30032209" : "30014230",
  }));
  const selectedDrafts = drafts.slice(0, 2).map((row, index) => ({
    ...row,
    folderId: index ? "30032209" : "30014230",
  }));
  const result = validateAylaVimeoMappingImport({ mappings: selected, drafts: [...drafts, ...selectedDrafts] });
  assert.equal(result.valid, true);
  assert.equal(result.expected_count, 2);
  assert.deepEqual(result.folder_ids, ["30014230", "30032209"]);
});

test("dry-run rejects excluded Kaplan folder", () => {
  const kaplanMapping = [{ ...mappings[0], source_folder_id: "30105823" }];
  const kaplanDraft = [{ ...drafts[0], folderId: "30105823" }];
  const result = validateAylaVimeoMappingImport({ mappings: kaplanMapping, drafts: kaplanDraft });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("not approved")));
});

test("new private folder IDs are intake-ready but still require an explicit exam and full hierarchy", () => {
  const intakeMapping = [{
    ...mappings[0],
    source_folder_id: "30159726",
    proposed_exam: "MCCQE",
    proposed_system: "Cardiovascular",
    proposed_subsystem: "Acute Care",
    proposed_topic: "Chest pain",
    proposed_subtopic: "Management",
  }];
  const intakeDraft = [{ ...drafts[0], folderId: "30159726" }];
  assert.equal(validateAylaVimeoMappingImport({ mappings: intakeMapping, drafts: intakeDraft }).valid, true);
  assert.equal(validateAylaVimeoMappingImport({
    mappings: [{ ...intakeMapping[0], proposed_exam: "" }], drafts: intakeDraft,
  }).valid, false);
});

test("dry-run rejects incomplete hierarchy and duplicate IDs", () => {
  const broken = mappings.map((row) => ({ ...row }));
  broken[0].proposed_subtopic = "";
  broken[1].vimeo_id = broken[0].vimeo_id;
  const result = validateAylaVimeoMappingImport({ mappings: broken, drafts });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("subtopic is required")));
  assert.ok(result.errors.some((error) => error.includes("duplicate vimeo_id")));
});

test("apply changes hierarchy only and preserves private approval state", () => {
  const validation = validateAylaVimeoMappingImport({ mappings, drafts });
  const result = applyAylaVimeoMappings(drafts, validation, { actor: { id: "admin-1" }, now: new Date("2026-08-05T00:00:00Z") });
  assert.equal(result.updated, 491);
  assert.equal(result.drafts[0].status, "classification_failed");
  assert.equal(result.drafts[0].reviewStatus, "pending");
  assert.equal(result.drafts[0].approved, false);
  assert.equal(result.drafts[0].classification.subtopic, "Subtopic 0");
  assert.equal(result.drafts[0].classification.approvalReadiness, "ready_for_owner_approval");
});

test("server exposes validation-first import with fingerprint and confirmation gates", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/mapping-import"');
  const end = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/classification-jobs"', start);
  const route = server.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(route, /expectedFingerprint !== validation\.fingerprint/);
  assert.match(route, /APPLY_PRIVATE_VIMEO_MAPPINGS_\$\{validation\.expected_count\}/);
  assert.match(route, /active_resources_created: 0/);
  assert.match(route, /classifier_jobs_started: 0/);
  assert.match(route, /mapped_but_inactive_until_manual_approval/);
});
