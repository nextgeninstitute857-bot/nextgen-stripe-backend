import assert from "node:assert/strict";
import test from "node:test";
import { buildPlabTaxonomyRepairPreview } from "../lib/content-registry-postgres.js";

function row(id, provider, sysId, subId, system = "Medicine", override = false) {
  return {
    id,
    title: `Question - ${id}`,
    status: "approved",
    taxonomy: {
      system_key: `plab:${system.toLowerCase().replaceAll(" ", "_")}`,
      subsystem_key: "plab:medicine:clinical_capability",
      topic_key: `plab:medicine:topic_${id}`,
      subtopic_key: `plab:medicine:topic_${id}:management`,
      labels: { system, subsystem: "Clinical Capability", topic: `Topic ${id}`, subtopic: "Management" },
    },
    source_data: {
      source_system_id_raw: String(sysId),
      source_subject_id_raw: String(subId),
      source_file: provider,
    },
    alias_source_providers: [provider],
    alias_source_namespaces: [],
    has_active_override: override,
  };
}

test("PLAB preview resolves eight controlled systems while preserving live publication controls", () => {
  const questions = [
    row("00000000-0000-4000-8000-000000000001", "BMJ OnExamination", 5650, 0),
    row("00000000-0000-4000-8000-000000000002", "BMJ OnExamination", 5649, 0),
    row("00000000-0000-4000-8000-000000000003", "BMJ OnExamination", 5657, 0),
    row("00000000-0000-4000-8000-000000000004", "BMJ OnExamination", 5666, 0),
    row("00000000-0000-4000-8000-000000000005", "BMJ OnExamination", 5651, 0),
    row("00000000-0000-4000-8000-000000000006", "BMJ OnExamination", 5660, 0),
    row("00000000-0000-4000-8000-000000000007", "BMJ OnExamination", 5663, 0),
    row("00000000-0000-4000-8000-000000000008", "BMJ OnExamination", 5655, 0),
  ];
  const preview = buildPlabTaxonomyRepairPreview(questions, {
    collection_count: 3,
    approved_collection_count: 3,
    enabled_destination_count: 21,
  }).publicPreview;
  assert.equal(preview.ready, true);
  assert.equal(preview.question_count, 8);
  assert.equal(preview.repairable, 8);
  assert.equal(preview.coverage_after_repair.systems, 8);
  assert.equal(preview.enabled_destination_count, 21);
  assert.equal(preview.safeguards.publication_state_changed, false);
  assert.equal(preview.safeguards.student_history_changed, 0);
  assert.match(preview.audit_fingerprint, /^[a-f0-9]{64}$/);
});

test("PLAB preview fails closed for unknown IDs or active manual overrides", () => {
  const unknown = buildPlabTaxonomyRepairPreview([
    row("00000000-0000-4000-8000-000000000009", "Unknown", 999999, 999999),
  ]).publicPreview;
  assert.equal(unknown.ready, false);
  assert.ok(unknown.blockers.includes("plab_source_discipline_not_fully_resolvable"));

  const overridden = buildPlabTaxonomyRepairPreview([
    row("00000000-0000-4000-8000-000000000010", "BMJ OnExamination", 5650, 0, "Medicine", true),
  ]).publicPreview;
  assert.equal(overridden.ready, false);
  assert.ok(overridden.blockers.includes("active_taxonomy_override_present"));
});
