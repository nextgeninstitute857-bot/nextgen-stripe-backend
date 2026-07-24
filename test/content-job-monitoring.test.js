import test from "node:test";
import assert from "node:assert/strict";
import { contentJobMonitoring } from "../lib/content-job-monitoring.js";

const NOW = Date.parse("2026-07-23T06:00:00.000Z");

function job(overrides = {}) {
  return {
    id: "background-1",
    status: "running",
    attempts: 2,
    interrupted_count: 1,
    progress: {},
    created_at: "2026-07-23T05:00:00.000Z",
    updated_at: "2026-07-23T05:59:50.000Z",
    started_at: "2026-07-23T05:00:00.000Z",
    heartbeat_at: "2026-07-23T05:59:50.000Z",
    ...overrides,
  };
}

test("media monitoring reports durable processed/total progress", () => {
  const monitoring = contentJobMonitoring([job({
    progress: {
      stage: "uploading_private_images",
      files_processed: 25,
      files_total: 100,
      bytes_processed: 5_000,
      bytes_total: 20_000,
      current_file: "images/diagram.png",
      movement_at: "2026-07-23T05:59:48.000Z",
      resumed_files: 10,
      newly_uploaded: 15,
    },
  })], { nowMs: NOW, staleMs: 180_000 });

  assert.equal(monitoring.available, true);
  assert.equal(monitoring.percent, 25);
  assert.equal(monitoring.files_processed, 25);
  assert.equal(monitoring.files_total, 100);
  assert.equal(monitoring.resumed_files, 10);
  assert.equal(monitoring.newly_uploaded, 15);
  assert.equal(monitoring.movement, "moving");
  assert.equal(monitoring.stalled, false);
  assert.equal(monitoring.worker_unresponsive, false);
});

test("accelerated media monitoring exposes workers, checkpoint lag, speed, and ETA", () => {
  const monitoring = contentJobMonitoring([job({
    progress: {
      stage: "uploading_private_images",
      files_processed: 9_200,
      files_total: 35_037,
      bytes_processed: 1_710_000_000,
      durable_bytes_processed: 1_700_000_000,
      bytes_total: 6_700_000_000,
      resumed_files: 9_157,
      newly_uploaded: 43,
      workers_configured: 4,
      workers_active: 4,
      checkpoint_batch_size: 25,
      checkpoint_pending: 7,
      files_per_minute: 81.25,
      eta_seconds: 19_080,
      inventory_cache: "legacy_v2_totals",
      accelerated: true,
    },
  })], { nowMs: NOW });

  assert.equal(monitoring.workers_configured, 4);
  assert.equal(monitoring.workers_active, 4);
  assert.equal(monitoring.checkpoint_batch_size, 25);
  assert.equal(monitoring.checkpoint_pending, 7);
  assert.equal(monitoring.files_per_minute, 81.25);
  assert.equal(monitoring.eta_seconds, 19_080);
  assert.equal(monitoring.durable_bytes_processed, 1_700_000_000);
  assert.equal(monitoring.inventory_cache, "legacy_v2_totals");
  assert.equal(monitoring.accelerated, true);
});

test("fresh worker heartbeats do not hide a transfer that stopped moving", () => {
  const monitoring = contentJobMonitoring([job({
    heartbeat_at: "2026-07-23T05:59:50.000Z",
    progress: {
      stage: "uploading_private_images",
      files_processed: 25,
      files_total: 100,
      movement_at: "2026-07-23T05:50:00.000Z",
    },
  })], { nowMs: NOW, staleMs: 180_000 });

  assert.equal(monitoring.worker_unresponsive, false);
  assert.equal(monitoring.stalled, true);
  assert.equal(monitoring.movement, "stalled");
  assert.equal(monitoring.movement_age_seconds, 600);
});

test("a stale legacy heartbeat is identified as both stalled and unresponsive", () => {
  const monitoring = contentJobMonitoring([job({
    heartbeat_at: "2026-07-23T05:00:00.000Z",
    progress: { stage: "uploading_private_images" },
  })], { nowMs: NOW, staleMs: 180_000 });

  assert.equal(monitoring.stalled, true);
  assert.equal(monitoring.worker_unresponsive, true);
});

test("completed jobs always report 100 percent", () => {
  const monitoring = contentJobMonitoring([job({
    status: "completed",
    progress: { stage: "image_import_complete", files_processed: 99, files_total: 100 },
  })], { nowMs: NOW });

  assert.equal(monitoring.percent, 100);
  assert.equal(monitoring.movement, "complete");
  assert.equal(monitoring.stalled, false);
});

test("Postgres disk exhaustion is reported separately from transfer failures", () => {
  const postgres = contentJobMonitoring([job({
    status: "retry_wait",
    error: "could not extend file \"base/123/456\": No space left on device",
  })], { nowMs: NOW });
  const r2 = contentJobMonitoring([job({
    status: "retry_wait",
    error: "Cloudflare R2 request timed out",
  })], { nowMs: NOW });

  assert.equal(postgres.error_category, "postgres_storage");
  assert.equal(r2.error_category, "object_storage_transfer");
});
