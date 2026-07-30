import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  AYLA_BROKEN_IMAGE_MCQ_REFERENCES,
  AYLA_ORIGINAL_MCQ_REPAIR_CONFIRMATION,
  AYLA_ORIGINAL_MCQ_REPLACEMENTS,
  aylaOriginalMcqContentHash,
  buildAylaOriginalMcqRepairPreview,
  validateAylaOriginalMcqReplacements,
} from "../lib/aylamed-original-mcq-repair.js";

function catalogRows() {
  return AYLA_ORIGINAL_MCQ_REPLACEMENTS.map((item, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    student_qid: `NGQ-${String(index + 1).padStart(8, "0")}`,
    title: `Quarantined source ${index + 1}`,
    status: "quarantined",
    question_html: `<p>Legacy media: ${item.brokenRefs.join(" ")}</p>`,
    explanation_html: "",
    media_refs: item.brokenRefs,
  }));
}

test("the controlled repair contains 13 original, text-complete, owned definitions", () => {
  const validation = validateAylaOriginalMcqReplacements();
  assert.equal(validation.valid, true);
  assert.equal(validation.replacementCount, 13);
  assert.equal(AYLA_ORIGINAL_MCQ_REPLACEMENTS.length, 13);
  assert.ok(AYLA_BROKEN_IMAGE_MCQ_REFERENCES.length > 13);
  assert.equal(new Set(Object.values(validation.contentHashes)).size, 13);

  for (const item of AYLA_ORIGINAL_MCQ_REPLACEMENTS) {
    assert.match(item.questionHtml, /<strong>/);
    assert.doesNotMatch(item.questionHtml, /<img\b/i);
    assert.equal(item.answers.filter((answer) => (
      answer.answerId === item.correctAnswerId
    )).length, 1);
    assert.ok(item.references.every((url) => url.startsWith("https://")));
    assert.equal(aylaOriginalMcqContentHash(item).length, 64);
  }
});

test("preview is ready only when every repair slot maps to one catalog question", () => {
  const ready = buildAylaOriginalMcqRepairPreview(catalogRows());
  assert.equal(ready.ready, true);
  assert.equal(ready.originalCount, 13);
  assert.equal(ready.replacementCount, 13);
  assert.equal(ready.matches.filter((row) => row.replacementKey).length, 13);
  assert.equal(ready.fingerprint.length, 64);

  const missing = buildAylaOriginalMcqRepairPreview(catalogRows().slice(0, 12));
  assert.equal(missing.ready, false);
  assert.ok(missing.errors.some((error) => error.startsWith("catalog_match_count:")));

  const duplicate = buildAylaOriginalMcqRepairPreview([
    ...catalogRows(),
    { ...catalogRows()[0], id: "00000000-0000-4000-8000-999999999999" },
  ]);
  assert.equal(duplicate.ready, false);
  assert.ok(duplicate.errors.some((error) => error.startsWith("definition_match_count:")));
});

test("server exposes preview-first repair controls and requires explicit review", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const registry = fs.readFileSync(
    new URL("../lib/content-registry-postgres.js", import.meta.url),
    "utf8",
  );
  assert.match(server, /\/api\/ayla\/admin\/catalog\/image-mcq-repair\/preview/);
  assert.match(server, /\/api\/ayla\/admin\/catalog\/image-mcq-repair\/apply/);
  assert.match(server, /medical_review_confirmed/);
  assert.match(registry, /content_question_remediation_events/);
  assert.match(registry, /status='quarantined'/);
  assert.match(registry, /source_rights_status='owned'/);
  assert.match(registry, /originalsDeleted: 0/);
  assert.equal(
    AYLA_ORIGINAL_MCQ_REPAIR_CONFIRMATION,
    "PUBLISH 13 AYLA ORIGINAL REPLACEMENTS",
  );
});
