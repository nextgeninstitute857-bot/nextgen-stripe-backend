import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const registry = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);
const shell = fs.readFileSync(
  new URL("../lib/aylamed-student-shell.js", import.meta.url),
  "utf8",
);

test("v256 wires one private exam-scoped NBME Center through admin, student and registry boundaries", () => {
  assert.match(server, /AYLA_NBME_CENTER_BUILD/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/nbme-center\/manifests"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/nbme-center\/sync"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/nbme-center\/content-imports\/:jobId\/media\/import-draft"/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/nbme-center\/content-media-imports\/:mediaJobId"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/nbme-center\/collections\/:collectionId\/release"/);
  assert.match(server, /app\.patch\("\/api\/ayla\/admin\/nbme-center\/forms\/:formId"/);
  assert.match(server, /app\.get\("\/api\/ayla\/nbme-center\/catalog"/);
  assert.match(server, /app\.post\("\/api\/ayla\/nbme-center\/attempts"/);
  assert.match(server, /app\.get\("\/api\/ayla\/nbme-center\/attempts\/:attemptId"/);
  assert.match(server, /app\.put\("\/api\/ayla\/nbme-center\/attempts\/:attemptId\/answers"/);
  assert.match(server, /app\.post\("\/api\/ayla\/nbme-center\/attempts\/:attemptId\/submit"/);
  assert.match(server, /app\.get\("\/api\/ayla\/nbme-center\/history"/);
  assert.match(server, /answer_keys_before_submission:\s*false/);
  assert.match(server, /official_predicted_score:\s*false/);
  assert.match(server, /pass_guarantee:\s*false/);
  assert.match(server, /AYLA_NBME_REVIEWED_RELEASE_NAMESPACE = "aylamed-nbme-step-1-complete"/);
  assert.match(server, /String\(upload\.sha256 \|\| ""\) !== String\(parentJob\.zip_sha256 \|\| ""\)/);
  assert.match(server, /Number\(collection\.question_count \|\| 0\) !== definition\.expectedQuestionCount/);
  assert.match(server, /destination: "aylamed_nbme"/);
  assert.match(registry, /export async function listContentNbmeCollections/);
  assert.match(registry, /export async function getContentNbmeCollectionQuestions/);
  assert.match(registry, /d\.destination='aylamed_nbme' AND d\.enabled=TRUE/);
  assert.match(shell, /\{\s*key:\s*"nbme_center",\s*label:\s*"NBME Center",\s*route:\s*"nbme"/);
});

test("v256 persists only assessment metadata and attempts in AylaMed collections", () => {
  assert.match(server, /aylaNbmeForms:/);
  assert.match(server, /aylaNbmeAttempts:/);
  assert.match(server, /aylaNbmeAuditEvents:/);
  assert.doesNotMatch(server, /aylaNbmeQuestions:/);
  assert.doesNotMatch(server, /aylaNbmeMedia:/);
});
