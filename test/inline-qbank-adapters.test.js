import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { previewUniversalQuestionZip } from "../lib/content-zip-import.js";

async function previewFixture({
  provider,
  namespace,
  question,
  answers,
  stem = "fixture",
  examTrack = "usmle-step-1",
}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-inline-bank-"));
  const questionName = `${stem}.db_questions.json`;
  const answerName = `${stem}.db_answers.json`;
  const questionPath = path.join(directory, questionName);
  const answerPath = path.join(directory, answerName);
  await fs.writeFile(questionPath, JSON.stringify([question]));
  await fs.writeFile(answerPath, JSON.stringify(answers));
  try {
    return await previewUniversalQuestionZip({
      inventory: {
        names: [questionName, answerName],
        extractedJson: new Map([
          [questionName, questionPath],
          [answerName, answerPath],
        ]),
        mediaKeys: new Set(),
        entryCount: 2,
        uncompressedBytes: 1_024,
      },
      examTrack,
      sourceNamespace: namespace,
      sourceProvider: provider,
      collectionTitle: "Fixture",
      duplicateLookup: async () => ({ exact: [], source: [] }),
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("AMBOSS paired exports preview through the provider-aware SBA adapter", async () => {
  const preview = await previewFixture({
    provider: "AMBOSS",
    namespace: "amboss-step1-2025",
    stem: "ambossqb-USMLE Step 12025",
    question: {
      id: 1,
      question: '<p onclick="alert(1)">Stem?</p>',
      explanation: "<p>Explanation</p>",
      corrAns: 2,
      sysId: "9",
      subId: "2,12,22",
    },
    answers: [
      { id: 1, qId: 1, answerId: 1, answerText: "A" },
      { id: 2, qId: 1, answerId: 2, answerText: "B" },
    ],
  });
  assert.equal(preview.counts.import_blocked, false);
  assert.equal(preview.counts.valid_questions, 1);
  assert.deepEqual(preview.counts.source_adapters, { amboss_sba_v1: 1 });
  assert.deepEqual(preview.counts.item_formats, { single_best_answer: 1 });
});

for (const fixture of [
  {
    name: "CanadaQBank",
    provider: "CanadaQBank",
    namespace: "canadaqbank-usmle-step1-2025",
    stem: "cqb-usmlestep1-2025",
    examTrack: "usmle-step-1",
    expectedAdapter: "canadaqbank_sba_v1",
    question: { sysId: 587, subId: 111 },
  },
  {
    name: "Amedex",
    provider: "Amedex",
    namespace: "amedex-mcq-2025",
    stem: "amedexmcq-2025",
    examTrack: "amc",
    expectedAdapter: "flat_system_sba_v1",
    question: { sysId: 21, subId: 0 },
  },
  {
    name: "MPlusX",
    provider: "MPlusX",
    namespace: "mplusx-2025",
    stem: "mplusx-2025",
    examTrack: "amc",
    expectedAdapter: "flat_system_sba_v1",
    question: { sysId: 26, subId: 0 },
  },
]) {
  test(`${fixture.name} previews in its confirmed exam track`, async () => {
    const preview = await previewFixture({
      provider: fixture.provider,
      namespace: fixture.namespace,
      stem: fixture.stem,
      examTrack: fixture.examTrack,
      question: {
        id: 1,
        question: '<p>Stem?</p>',
        explanation: '<p>Explanation</p>',
        corrAns: 2,
        ...fixture.question,
      },
      answers: [
        { id: 1, qId: 1, answerId: 1, answerText: "A" },
        { id: 2, qId: 1, answerId: 2, answerText: "B" },
      ],
    });
    assert.equal(preview.counts.import_blocked, false);
    assert.equal(preview.counts.valid_questions, 1);
    assert.deepEqual(preview.counts.source_adapters, { [fixture.expectedAdapter]: 1 });
    assert.deepEqual(preview.counts.item_formats, { single_best_answer: 1 });
  });
}

test("CanadaQBank Step 1 export is blocked if an administrator selects MCCQE", async () => {
  const preview = await previewFixture({
    provider: "CanadaQBank",
    namespace: "canadaqbank-usmle-step1-2025",
    stem: "cqb-usmlestep1-2025",
    examTrack: "mccqe",
    question: {
      id: 1,
      question: "<p>Stem?</p>",
      explanation: "<p>Explanation</p>",
      corrAns: 2,
      sysId: 587,
      subId: 111,
    },
    answers: [
      { id: 1, qId: 1, answerId: 1, answerText: "A" },
      { id: 2, qId: 1, answerId: 2, answerText: "B" },
    ],
  });
  assert.equal(preview.counts.valid_questions, 0);
  assert.equal(preview.counts.quarantined, 1);
  assert.equal(preview.counts.import_blocked, true);
  assert.deepEqual(preview.counts.blocking_reasons, { source_exam_track_mismatch: 1 });
  assert.ok(preview.errors[0].errors.includes("source_exam_track_mismatch"));
});

test("CDM self-rating exports are quarantined and block ordinary MCQ draft import", async () => {
  const preview = await previewFixture({
    provider: "AceQBank",
    namespace: "aceqbank-cdm-2024",
    stem: "aceqbank-cdm-2024",
    examTrack: "mccqe",
    question: {
      id: 1,
      question: "<p>CDM CASE 1</p>",
      explanation: "<p>Maximum number of allowed responses: 3</p><p>Correct answer(s)</p>",
      corrAns: 1,
      sysId: 0,
      subId: 0,
    },
    answers: [
      { id: 1, qId: 1, answerId: 1, answerText: "I know this" },
      { id: 2, qId: 1, answerId: 2, answerText: "I don't know this" },
    ],
  });
  assert.equal(preview.counts.valid_questions, 0);
  assert.equal(preview.counts.quarantined, 1);
  assert.equal(preview.counts.import_blocked, true);
  assert.equal(preview.counts.blocking_issues, 1);
  assert.deepEqual(preview.counts.blocking_collections, ["aceqbank-cdm-2024-db"]);
  assert.deepEqual(preview.counts.source_adapters, { cdm_self_rating_v1: 1 });
  assert.deepEqual(preview.counts.item_formats, { cdm_self_rating_case: 1 });
  assert.ok(preview.errors[0].errors.includes("specialized_cdm_interaction_required"));
});
