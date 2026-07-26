import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const video = fs.readFileSync(
  new URL("../lib/content-video-vimeo.js", import.meta.url),
  "utf8",
);
const zipSource = fs.readFileSync(
  new URL("../lib/content-zip-source.js", import.meta.url),
  "utf8",
);
const registry = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);

test("2026 recovery exposes separate dry-run and fingerprint-guarded apply routes", () => {
  assert.match(
    server,
    /content-media-imports\/:mediaJobId\/edition-audit/,
  );
  assert.match(
    server,
    /content-media-imports\/:mediaJobId\/reconcile-edition-draft-links/,
  );
  assert.match(
    server,
    /content-video-imports\/:videoJobId\/edition-audit/,
  );
  assert.match(
    server,
    /content-video-imports\/:videoJobId\/reconcile-edition-draft-links/,
  );
  assert.match(server, /expectedFingerprint !== audit\.fingerprint/);
});

test("edition recovery scopes references and assets before matching", () => {
  assert.match(
    server,
    /filterContentReferencesByEdition\(allReferences, edition\)/,
  );
  assert.match(
    server,
    /filterContentAssetsByEdition\(allAssets, edition\)/,
  );
  assert.match(server, /other_editions_touched: \[\]/);
  assert.match(server, /source_snapshot_scoped: true/);
});

test("edition image recovery inserts only exact missing links and protects conflicts", () => {
  const start = server.indexOf(
    'app.post("/admin/crm/ai-training/content-media-imports/:mediaJobId/reconcile-edition-draft-links"',
  );
  const end = server.indexOf(
    'app.get("/admin/crm/ai-training/content-media-imports/:mediaJobId/mapping-audit"',
    start,
  );
  const route = server.slice(start, end);
  assert.match(route, /audit\.linkAudit\.missingMatches\.slice/);
  assert.match(route, /protected_conflicts/);
  assert.match(route, /existing_links_overwritten: 0/);
  assert.match(route, /student_resources_published: 0/);
  assert.doesNotMatch(route, /deleteR2Object/);
});

test("edition video recovery inventories every video in the year before reference matching", () => {
  assert.match(video, /export async function inspectContentVideoEntries/);
  assert.match(video, /contentPathMatchesEdition\(originalName, cleanEdition\)/);
  assert.match(server, /inspectContentVideoEntries\(/);
  assert.match(server, /matchVideoReferences\(references, inventory\.videos\)/);
  assert.match(server, /filename_treated_as_question_id: false/);
  assert.match(server, /sha256_vimeo_deduplication: true/);
});

test("Vimeo streaming reuses the edition ZIP directory cache", () => {
  assert.match(
    video,
    /directoryCacheKey: String\(directoryCacheKey \|\| ""\)/,
  );
  assert.match(
    video,
    /\{ directoryCacheKey: video\?\.directoryCacheKey \|\| "" \}/,
  );
  assert.match(
    zipSource,
    /openNamedContentZipEntry\(value, entryName, \{\s*directoryCacheKey = ""/,
  );
  assert.match(
    zipSource,
    /openContentZip\(value, \{\s*autoClose: false,\s*directoryCacheKey,/,
  );
});

test("existing video mappings are audited and never overwritten", () => {
  assert.match(
    registry,
    /export async function auditContentVideoMappings\(matches = \[\]\)/,
  );
  assert.match(registry, /LEFT JOIN content_question_videos qv/);
  assert.match(server, /auditContentVideoMappings\(report\.matches\)/);
  assert.match(server, /existing_video_links_overwritten: false/);
});

test("cross-edition video fallback is fingerprint guarded and keeps the target question edition", () => {
  assert.match(
    server,
    /content-video-imports\/:videoJobId\/fallback-audit/,
  );
  assert.match(
    server,
    /content-video-imports\/:videoJobId\/reconcile-fallback-draft-links/,
  );
  assert.match(server, /candidate_editions/);
  assert.match(video, /cleanCandidateEditions/);
  assert.match(video, /archiveFingerprint/);
  assert.match(server, /target_question_edition_only: true/);
  assert.match(server, /latest_edition_preference: true/);
  assert.match(
    server,
    /matchVideoReferences\(references, extracted\.videos, \{\s*\.\.\.\(candidateEditions\.length \? \{\s*candidatePriority: ngContentCandidatePriority\(candidateEditions\)/,
  );
  assert.match(server, /"retry_wait",\s*"paused"/);
});

test("cross-edition image and audio fallback is fingerprint guarded and latest-first", () => {
  assert.match(
    server,
    /content-media-imports\/:mediaJobId\/fallback-audit/,
  );
  assert.match(
    server,
    /content-media-imports\/:mediaJobId\/reconcile-fallback-draft-links/,
  );
  assert.match(server, /ngContentCandidatePriority/);
  assert.match(server, /cross_edition_media_link_reconciliation/);
  assert.match(server, /existing_links_overwritten: 0/);
  assert.match(server, /student_resources_published: 0/);
});
