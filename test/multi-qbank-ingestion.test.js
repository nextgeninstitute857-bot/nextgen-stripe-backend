import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  AdaptiveCapacityGate,
  buildQbankIngestionDashboard,
  multiQbankIngestionConfig,
  providerRetryAfterMs,
  withProviderRateLimitBackoff,
} from "../lib/multi-qbank-ingestion.js";
import { SafeBackgroundQueue } from "../lib/safe-background-jobs.js";
import { uploadVideoToVimeo } from "../lib/content-video-vimeo.js";

async function waitFor(check, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for v239 state");
}

test("v239 defaults to two QBank media lanes with bounded shared capacity", () => {
  assert.deepEqual(multiQbankIngestionConfig({}), {
    build: "v241-2026-edition-media-recovery",
    max_active_jobs: 4,
    lane_concurrency: {
      question_zip: 2,
      image_zip: 2,
      video_zip: 2,
      ayla_vimeo_ai: 1,
    },
    media_workers_per_job: 8,
    media_global_transfer_limit: 12,
    media_min_transfer_limit: 4,
    postgres_finalizers: 1,
    media_finalization_batch_size: 1_000,
    vimeo_uploads: 2,
    vimeo_rate_limit_attempts: 6,
    memory_soft_percent: 70,
    memory_hard_percent: 82,
    job_lease_ms: 120_000,
    postgres_job_state: "disk_only_until_postgres_is_configured",
  });
  const clamped = multiQbankIngestionConfig({
    DATABASE_URL: "postgres://configured",
    NEXTGEN_CONTENT_JOB_CONCURRENCY: "99",
    NEXTGEN_CONTENT_MEDIA_JOB_CONCURRENCY: "20",
    NEXTGEN_CONTENT_MEDIA_CONCURRENCY: "20",
    NEXTGEN_CONTENT_GLOBAL_MEDIA_CONCURRENCY: "200",
    NEXTGEN_CONTENT_VIDEO_JOB_CONCURRENCY: "20",
    NEXTGEN_CONTENT_VIMEO_UPLOAD_CONCURRENCY: "20",
  });
  assert.equal(clamped.max_active_jobs, 8);
  assert.equal(clamped.lane_concurrency.image_zip, 4);
  assert.equal(clamped.media_workers_per_job, 12);
  assert.equal(clamped.media_global_transfer_limit, 24);
  assert.equal(clamped.lane_concurrency.video_zip, 4);
  assert.equal(clamped.vimeo_uploads, 4);
  assert.equal(clamped.postgres_job_state, "authoritative_with_disk_recovery_copy");
});

test("adaptive gate reduces new transfers under memory pressure without killing active work", async () => {
  let memoryPercent = 30;
  const gate = new AdaptiveCapacityGate({
    name: "test-r2",
    minimum: 1,
    normal: 3,
    maximum: 3,
    memorySoftPercent: 60,
    memoryHardPercent: 80,
    memoryProvider: () => ({ percent: memoryPercent }),
  });
  const releases = await Promise.all([
    gate.acquire(),
    gate.acquire(),
    gate.acquire(),
  ]);
  assert.equal(gate.snapshot().active, 3);
  memoryPercent = 90;
  assert.equal(gate.snapshot().effective_limit, 1);
  let fourthGranted = false;
  const fourth = gate.acquire().then((release) => {
    fourthGranted = true;
    return release;
  });
  releases[0]();
  releases[1]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fourthGranted, false);
  releases[2]();
  const releaseFourth = await fourth;
  assert.equal(fourthGranted, true);
  assert.equal(gate.snapshot().active, 1);
  releaseFourth();
  assert.equal(gate.snapshot().active, 0);
});

test("provider backoff honors Retry-After and succeeds without a whole-job restart", async () => {
  const delays = [];
  let attempts = 0;
  const result = await withProviderRateLimitBackoff(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw {
        response: {
          status: 429,
          headers: { "retry-after": attempts === 1 ? "2" : "1" },
        },
      };
    }
    return "ready";
  }, {
    maxAttempts: 4,
    random: () => 0,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  assert.equal(result, "ready");
  assert.deepEqual(delays, [2_000, 1_000]);
  assert.equal(providerRetryAfterMs({
    response: { headers: { "retry-after": "3" } },
  }), 3_000);
});

test("Vimeo TUS upload resumes from the provider offset after a 429", async () => {
  const bytes = Buffer.from("abcdef");
  let patches = 0;
  let sourceOpens = 0;
  const patchBodies = [];
  const sleeps = [];
  const result = await uploadVideoToVimeo({
    sizeBytes: bytes.length,
    name: "Cardiac cycle",
    streamFactory: () => {
      sourceOpens += 1;
      return Readable.from(bytes);
    },
    rateLimitAttempts: 3,
    adapters: {
      apiClient: {
        post: async () => ({
          data: {
            uri: "/videos/12345",
            upload: { upload_link: "https://upload.example.test/tus/12345" },
          },
        }),
      },
      httpClient: {
        patch: async (url, body, options) => {
          patches += 1;
          if (patches === 1) {
            throw {
              response: {
                status: 429,
                headers: { "retry-after": "1" },
              },
            };
          }
          const chunks = [];
          for await (const chunk of body) chunks.push(chunk);
          patchBodies.push(Buffer.concat(chunks).toString("utf8"));
          options.onUploadProgress?.({ loaded: 3, total: 3 });
          return { status: 204 };
        },
        head: async () => ({ headers: { "upload-offset": "3" } }),
      },
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      random: () => 0,
    },
  });
  assert.equal(result.providerId, "12345");
  assert.equal(patches, 2);
  assert.equal(sourceOpens, 2);
  assert.deepEqual(patchBodies, ["def"]);
  assert.deepEqual(sleeps, [1_000]);
});

test("PostgreSQL-style queue store receives checkpoints and execution leases", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "v234-job-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rows = new Map();
  const leases = new Set();
  const store = {
    kind: "postgres",
    async load() { return [...rows.values()].map((row) => structuredClone(row)); },
    async save(job) { rows.set(job.id, structuredClone(job)); },
    async acquireLease(jobId) {
      if (leases.has(jobId)) return false;
      leases.add(jobId);
      return true;
    },
    async renewLease(jobId) { return leases.has(jobId); },
    async releaseLease(jobId) { leases.delete(jobId); },
  };
  let active = 0;
  let maximum = 0;
  const queue = new SafeBackgroundQueue({
    directory,
    maxConcurrency: 2,
    laneConcurrency: { image_zip: 2 },
    persistentStore: store,
  });
  queue.register("media", async ({ job, updateCheckpoint }) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await updateCheckpoint({ durable: job.id }, { stage: "uploading_private_images" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await Promise.all(ids.map((id) => queue.enqueue({
    id,
    type: "media",
    lane: "image_zip",
  })));
  await waitFor(() => queue.summary().counts.completed === 2 && queue.summary().active === 0);
  assert.equal(maximum, 2);
  assert.equal(leases.size, 0);
  for (const id of ids) {
    assert.equal(rows.get(id).status, "completed");
    assert.deepEqual(rows.get(id).checkpoint, { durable: id });
  }
  assert.deepEqual(queue.summary().persistence, {
    authoritative: "postgres",
    disk_recovery_copy: true,
    execution_leases: true,
  });
});

test("QBank dashboard groups questions, media, videos, and background stages", () => {
  const registryJobs = {
    question_imports: [
      {
        id: "qbank-1",
        collection_title: "USMLE One",
        exam_track: "usmle-step-1",
        source_namespace: "source-one",
        source_provider: "Provider",
        status: "draft_imported",
        errors: [],
        created_at: "2026-07-25T10:00:00.000Z",
        updated_at: "2026-07-25T10:10:00.000Z",
      },
      {
        id: "qbank-2",
        collection_title: "PLAB One",
        exam_track: "plab",
        source_namespace: "source-two",
        source_provider: "Provider",
        status: "draft_imported_with_warnings",
        errors: [{ error: "One malformed source row" }],
        created_at: "2026-07-25T09:00:00.000Z",
        updated_at: "2026-07-25T09:10:00.000Z",
      },
    ],
    image_imports: [{
      id: "media-1",
      content_import_job_id: "qbank-1",
      status: "uploading",
      counts: {},
      errors: [],
      updated_at: "2026-07-25T10:20:00.000Z",
    }],
    video_imports: [],
  };
  const dashboard = buildQbankIngestionDashboard({
    registryJobs,
    backgroundJobs: [{
      id: "background-1",
      type: "content_image_draft",
      lane: "image_zip",
      status: "running",
      attempts: 1,
      max_attempts: 3,
      progress: { stage: "uploading_private_images", percent: 42 },
      metadata: { domain_job_id: "media-1" },
      updated_at: "2026-07-25T10:21:00.000Z",
    }],
    controlPlane: { capacity: { test: true } },
  });
  assert.equal(dashboard.summary.total_qbanks, 2);
  assert.equal(dashboard.summary.active_qbanks, 1);
  assert.equal(dashboard.qbanks[0].id, "qbank-1");
  assert.equal(dashboard.qbanks[0].status, "running");
  assert.equal(dashboard.qbanks[0].current_stage, "uploading_private_images");
  assert.equal(dashboard.qbanks[1].status, "completed_with_warnings");
  assert.equal(dashboard.qbanks[1].warnings.length, 1);
  assert.deepEqual(dashboard.control_plane, { capacity: { test: true } });
});

test("v239 server wiring keeps binaries private and serializes only finalization", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const postgres = await fs.readFile(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  assert.match(server, /const CONTENT_INGESTION_BUILD = MULTI_QBANK_INGESTION_BUILD/);
  assert.match(server, /laneConcurrency: ngMultiQbankConfig\.lane_concurrency/);
  assert.match(server, /transferGate: ngMediaTransferGate/);
  assert.match(server, /ngMediaFinalizerGate\.acquire/);
  assert.match(server, /ngVimeoUploadGate\.acquire/);
  assert.match(server, /Promise\.all\(uploadBatch\.map\(async \(group\)/);
  assert.match(server, /ngInFlightVimeoUploads\.get\(sha256\)/);
  assert.match(server, /findReusableContentVideos\(batch\)/);
  assert.match(server, /saveContentVideoLinksBatch\(\{/);
  assert.match(server, /app\.get\("\/admin\/crm\/operations\/qbank-ingestion"/);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS content_background_jobs/);
  assert.match(postgres, /lease_owner TEXT, lease_expires_at TIMESTAMPTZ/);
  assert.match(postgres, /export async function findReusableContentVideos/);
  assert.match(postgres, /export async function saveContentVideoLinksBatch/);
  assert.match(postgres, /INSERT INTO content_question_videos[\s\S]*?jsonb_to_recordset\(\$1::jsonb\)/);
  assert.match(postgres, /background_job_binaries_in_postgres: false/);
  assert.doesNotMatch(postgres, /content_background_jobs[\s\S]*?(?:BYTEA|large object)/i);
});
