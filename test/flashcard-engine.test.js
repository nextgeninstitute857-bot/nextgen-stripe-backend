import test from "node:test";
import assert from "node:assert/strict";
import {
  flashcardCapabilities,
  normalizeFlashcardRating,
  scheduleFlashcardReview,
  validateFlashcardContent,
} from "../lib/flashcard-engine.js";
import { flashcardPostgresStatus } from "../lib/flashcard-postgres.js";

test("LMS cannot gain AylaMed student source-creation features", () => {
  assert.equal(flashcardCapabilities("lms").studentSourceCreation, false);
  assert.equal(flashcardCapabilities("lms").videoTimestampSource, false);
  assert.equal(flashcardCapabilities("aylamed").studentSourceCreation, true);
});

test("legacy LMS confidence values map to review ratings", () => {
  assert.equal(normalizeFlashcardRating("low"), "again");
  assert.equal(normalizeFlashcardRating("medium"), "hard");
  assert.equal(normalizeFlashcardRating("high"), "good");
});

test("scheduler preserves lapses and produces a future due date", () => {
  const result = scheduleFlashcardReview({ interval_days: 8, ease_factor: 2.5, lapses: 1 }, "again", new Date("2026-07-17T10:00:00.000Z"));
  assert.equal(result.interval_days, 1);
  assert.equal(result.lapses, 2);
  assert.equal(result.next_review_date, "2026-07-18");
});

test("quality gate rejects instructional placeholder backs", () => {
  const result = validateFlashcardContent({ front: "What causes this finding?", back: "Explain the core mechanism and connect it to the assigned resource." });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("instruction_instead_of_answer"));
});

test("quality gate accepts an answer-bearing card", () => {
  const result = validateFlashcardContent({ front: "Which antibody is associated with Graves disease?", back: "Thyroid-stimulating immunoglobulin against the TSH receptor." });
  assert.equal(result.valid, true);
});

test("Postgres shadow status follows configuration while JSON remains authoritative", () => {
  const status = flashcardPostgresStatus();
  const expected = Boolean(
    String(process.env.DATABASE_URL || "").trim()
    && String(process.env.NEXTGEN_FLASHCARD_PG_SHADOW_WRITE || "false").toLowerCase() === "true"
  );
  assert.equal(status.shadow_write_enabled, expected);
  assert.equal(status.read_source, "json");
});
