import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTENT_SOURCE_ADAPTERS,
  adaptUniversalQuestion,
  validateAdaptedQuestion,
} from "../lib/content-import-adapter.js";
import { previewUniversalQuestionZip } from "../lib/content-zip-import.js";

function ownedQuestion(overrides = {}) {
  const question = {
    draft_id: "AY26-NUT-REFEED-001",
    exam_track: "usmle-step-1",
    stem_html: "<p>A patient develops electrolyte abnormalities after refeeding. What is the mechanism?</p>",
    options: [1, 2, 3, 4, 5].map((id) => ({ id, text_html: `Option ${id}` })),
    correct_option_id: 2,
    explanation_html: "<p>Insulin drives phosphate, potassium, and magnesium into cells.</p>",
    wrong_choice_explanations: {
      1: "This does not explain the coordinated intracellular shift.",
      3: "This produces a slower disturbance.",
      4: "Catabolism releases intracellular phosphate.",
      5: "This would not produce the observed pattern.",
    },
    educational_objective: "Recognize insulin-driven electrolyte shifts in refeeding syndrome.",
    difficulty: "moderate",
    cognitive_task_class: "interpretation",
    references: [{ citation: "ASPEN consensus recommendations for refeeding syndrome." }],
    taxonomy: {
      system: "Multisystem Processes & Disorders",
      subsystem: "Nutrition and metabolic health",
      topic: "Refeeding physiology",
      subtopic: "Insulin-driven intracellular electrolyte shifts",
    },
    controlled_taxonomy: {
      schema_version: "aylamed-controlled-taxonomy-v6",
      system_id: "multisystem-processes-disorders",
      system_name: "Multisystem Processes & Disorders",
      subsystem_id: "subsystem:multisystem-processes-disorders:biochemistrygeneral-principles",
      subsystem_name: "Biochemistry—General Principles",
      topic_id: "topic:uw-sys-1006",
      native_sys_id: 1006,
      topic_name: "Biochemistry—General Principles / sysId 1006",
      subtopic_id: "subtopic:uw-sys-1006:refeeding-physiology:3ab19db5f9a6",
      subtopic_name: "Insulin-driven intracellular electrolyte shifts",
      learning_objective_id: "objective:ay26-nut-refeed-001",
      clinical_labels: {
        subsystem: "Nutrition and metabolic health",
        topic: "Refeeding physiology",
        subtopic: "Insulin-driven intracellular electrolyte shifts",
      },
    },
    uworld_2026_blueprint: {
      native_sys_id: 1006,
      native_sub_id: 117,
      ayla_system_id: "multisystem-processes-disorders",
      mapping_status: "controlled-taxonomy-v6",
      clinician_content_review_status: "pending",
    },
    review: {
      factual: "pending_clinician",
      similarity: "pending",
      media: "not_required",
      publication: "blocked",
    },
    audit_metadata: {
      clinician_review: "pending",
      final_corpus_similarity_review: "pending",
      publication_allowed: false,
    },
  };
  return { ...question, ...overrides };
}

function adapt(question) {
  return adaptUniversalQuestion(question, [], {
    examTrack: "usmle-step-1",
    sourceNamespace: "aylamed-step1-owned-2026",
    sourceProvider: "AylaMed",
    collectionKey: "aylamed-owned",
    collectionTitle: "AylaMed Step 1 owned questions",
    sourceFile: "aylamed-owned_questions.json",
    sourcePosition: 1,
  });
}

async function preview(question) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-owned-import-"));
  const questionName = "aylamed-owned_questions.json";
  const questionPath = path.join(directory, questionName);
  await fs.writeFile(questionPath, JSON.stringify([question]));
  try {
    return await previewUniversalQuestionZip({
      inventory: {
        names: [questionName],
        extractedJson: new Map([[questionName, questionPath]]),
        mediaKeys: new Set(),
        entryCount: 1,
        uncompressedBytes: 1_024,
      },
      examTrack: "usmle-step-1",
      sourceNamespace: "aylamed-step1-owned-2026",
      sourceProvider: "AylaMed",
      collectionTitle: "AylaMed Step 1 owned questions",
      sourceFormat: "single_best_answer_v1",
      destinations: ["aylamed_qbank"],
      duplicateLookup: async () => ({ exact: [], source: [] }),
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("native AylaMed questions use inline options and preserve the controlled taxonomy ledger", () => {
  const row = adapt(ownedQuestion());
  assert.equal(row.sourceData.source_adapter, CONTENT_SOURCE_ADAPTERS.aylaMedOwnedSba);
  assert.equal(row.sourceItemId, "AY26-NUT-REFEED-001");
  assert.equal(row.answers.length, 5);
  assert.deepEqual(row.answers.map((answer) => answer.sourceId), ["1", "2", "3", "4", "5"]);
  assert.equal(row.correctAnswerId, 2);
  assert.equal(row.taxonomy.source, "aylamed_owned_json");
  assert.equal(row.taxonomy.ledger_fingerprint, "fd23f29b13f8537b61033ea5623278b0104d3cb177a52eb03d8a21630fbbb592");
  assert.deepEqual(validateAdaptedQuestion(row), []);
  assert.equal(row.sourceData.private_import_ready, true);
  assert.equal(row.sourceData.publication_gate_ready, false);
});

test("the registry retains source IDs privately and assigns its own automatic question number", async () => {
  const postgres = await fs.readFile(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  assert.match(postgres, /CREATE SEQUENCE IF NOT EXISTS content_student_qid_seq START 1/);
  assert.match(postgres, /student_qid TEXT NOT NULL UNIQUE DEFAULT \('NGQ-' \|\| LPAD\(nextval\('content_student_qid_seq'\)::text, 8, '0'\)\)/);
  assert.match(postgres, /source_item_id TEXT NOT NULL/);
  assert.match(postgres, /source_data: \{[\s\S]*?source_id: answer\.sourceId/);
  assert.match(postgres, /"question_id_mode":"internal","source_label_mode":"hidden"/);
});

test("native preview accepts a question-only JSON array and reports complete taxonomy without publishing", async () => {
  const result = await preview(ownedQuestion());
  assert.equal(result.counts.valid_questions, 1);
  assert.equal(result.counts.quarantined, 0);
  assert.equal(result.counts.import_blocked, false);
  assert.equal(result.counts.aylamed_owned_questions, 1);
  assert.equal(result.counts.taxonomy_ledger_complete, 1);
  assert.equal(result.counts.taxonomy_coverage_percent, 100);
  assert.equal(result.counts.publication_gate_ready, 0);
  assert.equal(result.counts.publication_gate_blocked, 1);
  assert.equal(result.taxonomyLedger.topics, 169);
  assert.equal(result.taxonomyLedger.controlled_question_taxonomy_records, 1776);
});

test("native preview reports real byte and question progress through completion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-owned-progress-"));
  const questionName = "aylamed-owned_questions.json";
  const questionPath = path.join(directory, questionName);
  await fs.writeFile(questionPath, JSON.stringify([ownedQuestion()]));
  const snapshots = [];
  try {
    await previewUniversalQuestionZip({
      inventory: {
        names: [questionName],
        extractedJson: new Map([[questionName, questionPath]]),
        mediaKeys: new Set(),
        entryCount: 1,
        uncompressedBytes: 1_024,
      },
      examTrack: "usmle-step-1",
      sourceNamespace: "aylamed-step1-owned-progress",
      sourceProvider: "AylaMed",
      collectionTitle: "AylaMed Step 1 progress test",
      sourceFormat: "single_best_answer_v1",
      destinations: ["aylamed_qbank"],
      duplicateLookup: async () => ({ exact: [], source: [] }),
      onProgress: async (snapshot) => snapshots.push(snapshot),
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  assert.ok(snapshots.some((snapshot) => snapshot.stage === "previewing_questions"));
  assert.equal(snapshots.at(-1).percent, 100);
  assert.equal(snapshots.at(-1).questions_processed, 1);
  assert.equal(snapshots.at(-1).questions_total, 1);
  assert.equal(snapshots.at(-1).bytes_processed, snapshots.at(-1).bytes_total);
});

test("native preview fails closed when a controlled taxonomy ID is outside the approved ledger", async () => {
  const question = ownedQuestion({
    controlled_taxonomy: {
      ...ownedQuestion().controlled_taxonomy,
      topic_id: "topic:not-approved",
    },
  });
  const result = await preview(question);
  assert.equal(result.counts.valid_questions, 0);
  assert.equal(result.counts.quarantined, 1);
  assert.equal(result.counts.import_blocked, true);
  assert.equal(result.counts.taxonomy_ledger_incomplete, 1);
  assert.equal(result.counts.blocking_reasons.taxonomy_topic_not_in_approved_ledger, 1);
});

test("publication readiness is separate from private validation and requires all human review gates", () => {
  const row = adapt(ownedQuestion({
    review: {
      factual: "approved",
      similarity: "human_approved",
      media: "not_required",
      publication: "approved",
      clinician: "approved",
    },
    audit_metadata: {
      clinician_review: "approved",
      final_corpus_similarity_review: "human_approved",
      publication_allowed: true,
    },
  }));
  assert.deepEqual(validateAdaptedQuestion(row), []);
  assert.equal(row.sourceData.publication_gate_ready, true);
});

test("negative review states can never pass by containing the word approved", () => {
  const row = adapt(ownedQuestion({
    review: {
      factual: "not_approved",
      similarity: "not_approved",
      media: "not_required",
      clinician: "not_approved",
    },
    audit_metadata: {
      clinician_review: "not_approved",
      final_corpus_similarity_review: "not_approved",
      publication_allowed: false,
    },
  }));
  assert.equal(row.sourceData.publication_gate_ready, false);
});

test("preview rejects archives with no recognized question JSON", async () => {
  await assert.rejects(
    () => previewUniversalQuestionZip({
      inventory: {
        names: ["registry.json"],
        extractedJson: new Map(),
        mediaKeys: new Set(),
        entryCount: 1,
        uncompressedBytes: 10,
      },
      examTrack: "usmle-step-1",
      sourceNamespace: "aylamed-step1-owned-2026",
      sourceProvider: "AylaMed",
      duplicateLookup: async () => ({ exact: [], source: [] }),
    }),
    (error) => error.code === "CONTENT_QUESTION_FILE_REQUIRED" && error.statusCode === 400,
  );
});
