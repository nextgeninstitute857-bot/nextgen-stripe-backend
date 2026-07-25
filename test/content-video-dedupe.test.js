import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = fs.readFileSync(fileURLToPath(new URL("../server.js", import.meta.url)), "utf8");
const registry = fs.readFileSync(fileURLToPath(new URL("../lib/content-registry-postgres.js", import.meta.url)), "utf8");

test("video import checks mappings and global SHA before Vimeo upload", () => {
  const runner = server.match(/async function ngRunContentVideoDraftImport[\s\S]*?\n}\n\napp\.post/)?.[0] || "";
  const batchLoop = runner.slice(runner.indexOf("for (let index = resumeProcessed"));
  const lookup = batchLoop.indexOf("findReusableContentVideos(batch)");
  const upload = batchLoop.indexOf("uploadVideoGroup(group)");
  assert.ok(lookup >= 0, "missing batch reusable-video lookup");
  assert.ok(upload > lookup, "Vimeo upload must occur only after the reusable-video lookup");
  assert.match(batchLoop, /reusable\.mappingKeys\.has\(key\)/);
  assert.match(batchLoop, /new Map\(reusable\.assetsBySha\)/);
});

test("reusable asset lookup is global by exact SHA", () => {
  const finder = registry.match(/export async function findReusableContentVideo[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(finder, /WHERE va\.sha256=\$1/);
  assert.doesNotMatch(finder, /source_namespace/);
  assert.doesNotMatch(finder, /exam_track/);
});

test("video job reports new uploads separately from reused content", () => {
  assert.match(server, /newly_uploaded: newlyUploaded/);
  assert.match(server, /reused_assets: reusedAssets/);
  assert.match(server, /reused_mappings: reusedMappings/);
  assert.match(server, /uploaded_to_vimeo: newlyUploaded/);
});
