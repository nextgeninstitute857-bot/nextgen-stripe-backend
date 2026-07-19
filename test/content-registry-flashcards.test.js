import test from "node:test";
import assert from "node:assert/strict";
import {
  contentRegistryFlashcardId,
  contentRegistryQuestionId,
  normalizeCourseExamTrack,
  registryQuestionToFlashcard,
} from "../lib/content-registry-flashcards.js";

test("registry flashcard IDs are namespaced and reversible", () => {
  const id = contentRegistryFlashcardId("2b00f21c-50d1-4a77-82d2-3d6623418a74");
  assert.equal(id, "registry-question:2b00f21c-50d1-4a77-82d2-3d6623418a74");
  assert.equal(contentRegistryQuestionId(id), "2b00f21c-50d1-4a77-82d2-3d6623418a74");
});

test("course labels resolve to an isolated exam track", () => {
  assert.equal(normalizeCourseExamTrack("USMLE Step 1 Complete Course"), "usmle-step-1");
  assert.equal(normalizeCourseExamTrack("NCLEX-RN Premium"), "nclex");
  assert.equal(normalizeCourseExamTrack("MCCQE Part 1"), "mccqe");
  assert.equal(normalizeCourseExamTrack("General medical course"), "unknown");
});

test("approved QBank question becomes a reveal-only card without answer choices", () => {
  const card = registryQuestionToFlashcard({
    id: "question-1", exam_track: "usmle-step-1", student_qid: "NGQ-00000001",
    question_html: "Clinical vignette", correct_answer_html: "Correct diagnosis",
    explanation_html: "Explanation", taxonomy: { system_key: "cardiovascular", topic_key: "murmurs" },
  }, { courseId: "step-1-course", reviewed: true });
  assert.equal(card.answer_mode, "reveal_only");
  assert.deepEqual(card.choices, []);
  assert.equal(card.read_only, true);
  assert.equal(card.reviewed, true);
  assert.equal(card.exam_track, "usmle-step-1");
});
