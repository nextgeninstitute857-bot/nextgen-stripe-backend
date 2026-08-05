import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const registry = fs.readFileSync(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

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
    "canonical_count_exact", "alias_count_exact", "no_shared_aliases",
    "no_delivery_history", "preview_collection_exact", "no_shared_media",
  ]) assert.match(registry, new RegExp(guard));
  assert.match(registry, /expectedFingerprint !== preflight\.fingerprint/);
  assert.match(registry, /nothing was deleted/);
  assert.match(registry, /BEGIN/);
  assert.match(registry, /ROLLBACK/);
});

test("cleanup API requires Ayla admin and exact finalized archive", () => {
  assert.match(server, /\/api\/ayla\/admin\/catalog\/uworld-cleanup\/preview/);
  assert.match(server, /\/api\/ayla\/admin\/catalog\/uworld-cleanup\/apply/);
  assert.match(server, /await aylaRequireAdmin\(req\)/);
  assert.match(server, /\^uworld 1\\\.zip\$/i);
  assert.match(server, /archiveCandidates\.length === 1/);
  assert.match(server, /expected !== preflight\.fingerprint/);
});

