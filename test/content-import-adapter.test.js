import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptUniversalQuestion,
  contentHash,
  extractMediaReferences,
  mediaMatchKeys,
  normalizeExamTrack,
  pairQuestionAnswerFiles,
  validateAdaptedQuestion,
} from "../lib/content-import-adapter.js";

test("exam aliases normalize without leaking track-specific IDs", () => {
  assert.equal(normalizeExamTrack("STEP 1"), "usmle-step-1");
  assert.equal(normalizeExamTrack("usmle_step_1"), "usmle-step-1");
  assert.equal(normalizeExamTrack("USMLE Step 2 CK"), "usmle-step-2");
  assert.equal(normalizeExamTrack("usmle_step_3"), "usmle-step-3");
  assert.equal(normalizeExamTrack("NCLEX"), "nclex");
});

test("question and answer files pair case-insensitively", () => {
  const pairs = pairQuestionAnswerFiles(["A_questions.json", "A_answers.json", "B_questions.json"]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].answerFile, "A_answers.json");
  assert.equal(pairs[1].answerFile, null);
});

test("media references normalize double extensions", () => {
  assert.deepEqual(extractMediaReferences('<img src="U612.jpg">', "L47301.jpg"), ["U612.jpg", "L47301.jpg"]);
  assert.deepEqual(extractMediaReferences("This sentence, however, is ordinary prose."), []);
  assert.deepEqual(extractMediaReferences("Listen to 12360.mp3, then review clip-1.mp4."), ["12360.mp3", "clip-1.mp4"]);
  assert.ok(mediaMatchKeys("iMD/U612.jpg.png").includes("u612"));
});

test("question/answer snapshots are ordered newest-first", () => {
  const pairs = pairQuestionAnswerFiles([
    "bank-2025-March_questions.json", "bank-2025-March_answers.json",
    "bank-2026-Mar_questions.json", "bank-2026-Mar_answers.json",
    "bank-2024-July_questions.json", "bank-2024-July_answers.json",
  ]);
  assert.equal(pairs[0].questionFile, "bank-2026-Mar_questions.json");
  assert.equal(pairs[2].questionFile, "bank-2024-July_questions.json");
});

test("high-resolution export prefixes map to the original JSON reference", () => {
  assert.ok(mediaMatchKeys("highresdefault_U17115.png").includes("u17115.png"));
  assert.ok(mediaMatchKeys("highresdefault_L29978.jpg.png").includes("l29978.jpg"));
});

test("exact duplicate hash ignores harmless HTML spacing", () => {
  const answers = [{ answerId: 1, answerText: "Alpha" }, { answerId: 2, answerText: "Beta" }];
  assert.equal(
    contentHash({ questionHtml: "<p>Question &nbsp; text</p>", answers }),
    contentHash({ questionHtml: "Question text", answers }),
  );
});

test("adapter validates correct answer and explanation", () => {
  const row = adaptUniversalQuestion({ id: 10, question: "<p>Stem?</p>", explanation: "Because", corrAns: 2 }, [
    { id: 1, qId: 10, answerId: 1, answerText: "A" },
    { id: 2, qId: 10, answerId: 2, answerText: "B" },
  ], { examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march" });
  assert.deepEqual(validateAdaptedQuestion(row), []);
  assert.equal(row.examTrack, "usmle-step-1");
  assert.equal(row.correctAnswerId, 2);
});

test("adapter preserves question versus explanation media placement", () => {
  const row = adaptUniversalQuestion({
    id: 11,
    question: '<p>Stem</p><img src="question.png">',
    explanation: '<p>Why</p><img src="explanation.jpg">',
    otherMedias: "12360.mp3,clip.mp4",
    corrAns: 1,
  }, [{ id: 1, qId: 11, answerId: 1, answerText: "A" }, { id: 2, qId: 11, answerId: 2, answerText: "B" }], {
    examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march",
  });
  assert.equal(row.sourceData.media_placements["question.png"], "question");
  assert.equal(row.sourceData.media_placements["explanation.jpg"], "explanation");
  assert.equal(row.sourceData.media_placements["12360.mp3"], "explanation");
  assert.equal(row.sourceData.media_placements["clip.mp4"], "explanation");
});

test("adapter collapses semantic low/high-resolution duplicates without moving question figures", () => {
  const row = adaptUniversalQuestion({
    id: 12,
    question: '<p>Stem</p><img src="U442.png">',
    explanation: '<p>Why</p><img src="highresdefault_L1436.jpg">',
    otherMedias: "highresdefault_U442.png,L1436.jpg,highresdefault_L1436.jpg",
    corrAns: 1,
  }, [{ id: 1, qId: 12, answerId: 1, answerText: "A" }, { id: 2, qId: 12, answerId: 2, answerText: "B" }], {
    examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march",
  });
  assert.deepEqual(row.media, ["U442.png", "highresdefault_L1436.jpg"]);
  assert.equal(row.sourceData.media_placements["U442.png"], "question");
  assert.equal(row.sourceData.media_placements["highresdefault_L1436.jpg"], "explanation");
});
