import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const postgres = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("media assets and question links are committed with set-based PostgreSQL batches", () => {
  assert.match(postgres, /export async function saveContentMediaMatchBatch/);
  assert.match(
    postgres,
    /INSERT INTO content_media_assets[\s\S]*?jsonb_to_recordset\(\$3::jsonb\)/,
  );
  assert.match(
    postgres,
    /INSERT INTO content_question_media[\s\S]*?jsonb_to_recordset\(\$2::jsonb\)/,
  );
  assert.match(postgres, /SELECT COUNT\(\*\)::int AS linked/);
  assert.match(postgres, /await client\.query\("COMMIT"\)/);
  assert.doesNotMatch(postgres, /DELETE FROM content_media_import_assets/);
});

test("media finalization checkpoints every committed batch and stays private", () => {
  assert.match(server, /const CONTENT_INGESTION_BUILD = MULTI_QBANK_INGESTION_BUILD/);
  assert.match(server, /finalizeMediaInBatches\(\{/);
  assert.match(server, /saveContentMediaMatchBatch\(\{/);
  assert.match(server, /buildMediaFinalizationCheckpoint\(\{/);
  assert.match(server, /queueContext\.updateCheckpoint\(durableCheckpoint/);
  assert.match(server, /finalization_assets_committed/);
  assert.match(server, /finalization_batches_committed/);
  assert.match(postgres, /status, source_data\)[\s\S]*?'draft'/);
});

test("autopilot ignores stale published and actively locked scheduled posts", () => {
  assert.match(
    server,
    /\.filter\(\(post\) => !ngPostPublished\(post\)\)[\s\S]*?publish_lock_until/,
  );
});
