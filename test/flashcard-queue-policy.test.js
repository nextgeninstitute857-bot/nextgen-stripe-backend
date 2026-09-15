import test from "node:test";
import assert from "node:assert/strict";
import { filterFlashcardsForSystem, flashcardMatchesCurrentSystem, flashcardPriorityRank } from "../lib/flashcard-queue-policy.js";

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

test("Review Cards system focus excludes unrelated cards", () => {
  const cards = [
    { id: "cns", system: "CNS" },
    { id: "msk", topic: "Musculoskeletal anatomy" },
    { id: "renal", tag: "Renal physiology" },
  ];

  assert.deepEqual(filterFlashcardsForSystem(cards, "MSK").map((card) => card.id), ["msk"]);
  assert.deepEqual(filterFlashcardsForSystem(cards, "Central Nervous System").map((card) => card.id), ["cns"]);
  assert.equal(filterFlashcardsForSystem(cards, ""), cards);
});
