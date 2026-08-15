import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("server exposes exam and per-resource publication switches and enforces them in learning delivery", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /aylaExamPublicationControls/);
  assert.match(server, /aylaResourcePublicationControls/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/publication-controls"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/publication-controls\/exams\/:examTrack"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/publication-controls\/resources\/:resourceType\/:resourceId"/);
  assert.match(server, /aylaRequireExamPublished\(auth\.db,[\s\S]*?"qbank"/);
  assert.match(server, /aylaRequireExamPublished\(db,[\s\S]*?"diagnostic"/);
  assert.match(server, /aylaRequireExamPublished\(initial\.db,[\s\S]*?"personal_tutor"/);
  assert.match(server, /aylaRequireExamPublished\(db,[\s\S]*?"assessment"/);
  assert.match(server, /aylaResourcePublishedFor\(db, video, examTrackId, destination\)/);
  assert.match(server, /aylaPublishedQbankCollectionIds/);
  assert.match(server, /collectionIds/);
  assert.match(server, /aylaListAllContentCollections/);
  assert.match(server, /aylaVimeoCatalogSources/);
  assert.match(server, /const supplementalResources = panel\.exams\.flatMap/);
  assert.match(server, /resource\.type !== "qbank_collection" \|\| resource\.delivery_channel === "qbank"/);
  assert.match(server, /source_exam_track_id: supplement\.source_exam_track/);
  assert.match(server, /scoring_allowed: false/);
});

test("MCCQE registry delivery loads Step 2 supplements with non-scoring metadata", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const videos = server.slice(
    server.indexOf("async function aylaV210RegistryVideoInputs"),
    server.indexOf("async function aylaV210EligibleVideos"),
  );
  assert.match(videos, /listAylaExamSupplements\(examTrack\)/);
  assert.match(videos, /sourceExamTrackId/);
  assert.match(videos, /supplementalForExamTrackId/);
  const qbank = server.slice(
    server.indexOf('app.get("/api/ayla/qbank/catalog"'),
    server.indexOf('app.post("/api/ayla/qbank/sessions"'),
  );
  assert.match(qbank, /supplemental: sourceExamTrack !== examTrack/);
  assert.match(qbank, /scoring_allowed: sourceExamTrack === examTrack/);
});
