import test from "node:test";
import assert from "node:assert/strict";
import { flashcardMatchesCurrentSystem, flashcardPriorityRank } from "../lib/flashcard-queue-policy.js";

test("weak areas remain the highest LMS flashcard priority", () => {
  assert.equal(flashcardPriorityRank({ bucket: "weak_area", system: "Renal" }, "Cardiovascular"), 0);
});

test("current-system session and class cards precede old-system and QBank cards", () => {
  const currentSession = { bucket: "tutor_notes", system: "Cardiovascular" };
  const currentClass = { bucket: "class_first_aid", system: "Cardiovascular" };
  const oldSession = { bucket: "tutor_notes", system: "Renal" };
  const qbank = { bucket: "published_bank", system: "Cardiovascular" };
  assert.equal(flashcardMatchesCurrentSystem(currentSession, "Cardiovascular System"), true);
  assert.ok(flashcardPriorityRank(currentSession, "Cardiovascular") < flashcardPriorityRank(oldSession, "Cardiovascular"));
  assert.ok(flashcardPriorityRank(currentClass, "Cardiovascular") < flashcardPriorityRank(qbank, "Cardiovascular"));
});
