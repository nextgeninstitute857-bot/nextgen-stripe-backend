import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const registry = fs.readFileSync(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const archive = fs.readFileSync(new URL("../lib/guarded-uworld-archive.js", import.meta.url), "utf8");

test("UWorld cleanup is pinned to the approved immutable targets", () => {
  assert.match(registry, /22913b91-4e8d-4a1f-b6a6-b09c94763cdc/);
  assert.match(registry, /435debf7-26c3-40f1-9449-22ab2acd3d04/);
  assert.match(registry, /expectedCanonicalQuestions:\s*7937/);
  assert.match(registry, /expectedAliases:\s*54597/);
  assert.match(registry, /expectedPreviewQuestions:\s*28/);
  assert.match(registry, /student:dx-323708-4e81e88b/);
});

test("UWorld cleanup fails closed on sharing, history, counts, and fingerprint", () => {
  for (const guard of [
    "canonical_count_exact", "alias_count_exact", "shared_aliases_partition_exact",
    "no_delivery_history", "preview_collection_exact", "media_partition_exact",
    "protected_media_excluded",
  ]) assert.match(registry, new RegExp(guard));
  assert.match(registry, /uworld_cleanup_deletable_questions/);
  assert.match(registry, /uworld_cleanup_deletable_objects/);
  assert.match(registry, /preserved_shared_canonical_questions/);
  assert.match(registry, /preserved_shared_media_objects/);
  assert.match(registry, /expectedFingerprint !== preflight\.fingerprint/);
  assert.match(registry, /nothing was deleted/);
  assert.match(registry, /BEGIN/);
  assert.match(registry, /ROLLBACK/);
});

test("cleanup API requires Ayla admin and exact R2-verified archive", () => {
  assert.match(server, /\/api\/ayla\/admin\/catalog\/uworld-cleanup\/preview/);
  assert.match(server, /\/api\/ayla\/admin\/catalog\/uworld-cleanup\/apply/);
  assert.match(server, /await aylaRequireAdmin\(req\)/);
  assert.match(server, /inspectGuardedUworldArchives/);
  assert.match(server, /headContentR2Object/);
  assert.match(server, /archiveInspection\.exact\.length === 1/);
  assert.match(archive, /\^uworld 1\\\.zip\$/i);
  assert.match(archive, /question_zip/);
  assert.match(archive, /image_zip/);
  assert.match(archive, /media_zip/);
  assert.match(archive, /exact_job_identity/);
  assert.match(archive, /no_active_leases/);
  assert.match(archive, /no_active_jobs/);
  assert.match(server, /expected !== preflight\.fingerprint/);
  assert.match(server, /deleteContentR2Object\(preflight\.archive\.object_key\)/);
});
