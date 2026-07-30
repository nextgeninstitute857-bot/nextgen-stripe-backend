import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const registry = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const flashcards = fs.readFileSync(
  new URL("../lib/content-registry-flashcards.js", import.meta.url),
  "utf8",
);

test("the registry persists source year and restricts new delivery to 2026, 2025, and 2024", () => {
  assert.match(registry, /content_import_jobs ADD COLUMN IF NOT EXISTS source_year SMALLINT/);
  assert.match(registry, /content_collections ADD COLUMN IF NOT EXISTS source_year SMALLINT/);
  assert.match(registry, /CONTENT_DELIVERY_SOURCE_YEARS\.join\(","\)/);
  assert.match(
    registry,
    /ORDER BY delivery\.source_year DESC,\s*CASE WHEN q\.id=ANY\(\$11::uuid\[\]\) THEN 1 ELSE 0 END/,
  );
});

test("required media is a fail-closed eligibility check and never a ranking signal", () => {
  assert.match(registry, /function contentQuestionMediaReadySql/);
  assert.match(registry, /ready_ma\.object_key/);
  assert.match(registry, /ready_va\.provider_id/);
  assert.match(registry, /quarantined/);
  assert.doesNotMatch(registry, /ORDER BY[^;]*has_verified_media/is);
});

test("QBank catalog, session creation, roadmap selection, diagnostics, and flashcards share the policy", () => {
  assert.match(server, /content_delivery_policy: contentDeliveryPolicySnapshot\(\)/);
  assert.match(server, /seenQuestionIds: aylaQbankSeenQuestionIds\(db/);
  assert.match(server, /session\.contentDeliveryPolicy = contentDeliveryPolicySnapshot\(\)/);
  assert.match(server, /seenQuestionIds,\s*\}\);/);
  assert.match(registry, /ORDER BY delivery\.source_year DESC, q\.student_qid, q\.id/);
});

test("flashcards remain text-only even when their source MCQ used verified media", () => {
  assert.match(flashcards, /front: flashcardTextOnlyHtml/);
  assert.match(flashcards, /media: \[\]/);
  assert.match(flashcards, /videos: \[\]/);
  assert.match(flashcards, /media_omitted_for_flashcard: true/);
});
