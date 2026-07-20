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
  assert.ok(mediaMatchKeys("iMD/U612.jpg.png").includes("u612"));
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
