import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  BoundedTaskPool,
  MediaAssetBatcher,
  buildMediaCheckpoint,
  mediaAcceleratorConfig,
  mediaInventoryCacheKey,
  mediaRateSnapshot,
  resolveMediaInventoryCheckpoint,
} from "../lib/media-ingestion-accelerator.js";
import { uploadMediaZipToR2 } from "../lib/content-media-r2.js";

test("media accelerator defaults to four bounded workers and clamps unsafe overrides", () => {
  assert.deepEqual(mediaAcceleratorConfig({}), {
    concurrency: 4,
    checkpoint_batch_size: 25,
    checkpoint_interval_ms: 5_000,
    progress_interval_ms: 15_000,
  });
  assert.deepEqual(mediaAcceleratorConfig({
    NEXTGEN_CONTENT_MEDIA_CONCURRENCY: "99",
    NEXTGEN_CONTENT_MEDIA_CHECKPOINT_BATCH_SIZE: "0",
    NEXTGEN_CONTENT_MEDIA_CHECKPOINT_INTERVAL_MS: "20",
    NEXTGEN_CONTENT_MEDIA_PROGRESS_INTERVAL_MS: "999999",
  }), {
    concurrency: 8,
    checkpoint_batch_size: 1,
    checkpoint_interval_ms: 1_000,
    progress_interval_ms: 60_000,
  });
});

test("inventory cache is keyed to the immutable ZIP and exact reference set", () => {
  const references = [
    { questionId: "q2", mediaRef: "images/b.png", placement: "explanation" },
    { questionId: "q1", mediaRef: "images/a.png", placement: "stem" },
  ];
  const key = mediaInventoryCacheKey({ zipSha256: "ABC", references });
  assert.equal(key, mediaInventoryCacheKey({ zipSha256: "abc", references: [...references].reverse() }));
  assert.notEqual(key, mediaInventoryCacheKey({
    zipSha256: "abc",
    references: [{ ...references[0], mediaRef: "images/changed.png" }, references[1]],
  }));

  const inventory = {
    entries: 37_155,
    uncompressedBytes: 7_000_000_000,
    candidateEntries: 35_037,
    candidateUncompressedBytes: 6_700_000_000,
  };
  const checkpoint = buildMediaCheckpoint({
    previous: { interrupted: true },
    cacheKey: key,
    inventory,
    progress: {
      media_entry_index: 9_157,
      files_processed: 9_157,
      bytes_processed: 1_700_000_000,
    },
  });
  assert.equal(checkpoint.version, 3);
  assert.equal(checkpoint.media_inventory.cache_key, key);
  assert.equal(checkpoint.files_total, 35_037);
  assert.equal(resolveMediaInventoryCheckpoint(checkpoint, key).source, "validated_cache");
  assert.equal(resolveMediaInventoryCheckpoint(checkpoint, "different").source, "miss");
});

test("version-two durable totals are adopted once without rescanning inventory", () => {
  const resolved = resolveMediaInventoryCheckpoint({
    version: 2,
    files_processed: 9_157,
    files_total: 35_037,
    bytes_processed: 1_700_000_000,
    bytes_total: 6_700_000_000,
  }, "new-key");
  assert.equal(resolved.source, "legacy_v2_totals");
  assert.equal(resolved.inventory.candidateEntries, 35_037);
  assert.equal(resolved.inventory.candidateUncompressedBytes, 6_700_000_000);
});

test("bounded task pool never exceeds its configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const pool = new BoundedTaskPool(3);
  await Promise.all(Array.from({ length: 12 }, () => pool.schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(5);
    active -= 1;
  })));
  await pool.drain();
  assert.equal(maximum, 3);
  assert.equal(pool.maximumActive, 3);
});

test("asset batcher flushes by size and by elapsed checkpoint interval", async () => {
  let now = 0;
  const batches = [];
  const batcher = new MediaAssetBatcher({
    batchSize: 2,
    intervalMs: 1_000,
    now: () => now,
    onFlush: async (batch) => batches.push(batch.map((item) => item.id)),
  });
  await batcher.add({ id: 1 });
  assert.deepEqual(batches, []);
  await batcher.add({ id: 2 });
  assert.deepEqual(batches, [[1, 2]]);
  now = 1_500;
  await batcher.add({ id: 3 });
  assert.deepEqual(batches, [[1, 2], [3]]);
});

test("asset batcher stops later batches after a durable checkpoint failure", async () => {
  const attempted = [];
  const batcher = new MediaAssetBatcher({
    batchSize: 1,
    onFlush: async (batch) => {
      attempted.push(batch[0].id);
      throw new Error("checkpoint unavailable");
    },
  });
  await assert.rejects(() => batcher.add({ id: 1 }), /checkpoint unavailable/);
  await assert.rejects(() => batcher.add({ id: 2 }), /checkpoint unavailable/);
  assert.deepEqual(attempted, [1]);
});

test("rate and ETA exclude instant resume skips from transfer speed", () => {
  assert.deepEqual(mediaRateSnapshot({
    startedAtMs: 0,
    nowMs: 60_000,
    newlyUploaded: 10,
    filesProcessed: 30,
    filesTotal: 50,
  }), {
    files_per_minute: 10,
    eta_seconds: 120,
  });
});

class FakeZip extends EventEmitter {
  constructor(entries) {
    super();
    this.entries = entries;
    this.offset = 0;
    this.closed = false;
  }

  readEntry() {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed) return;
      if (this.offset >= this.entries.length) this.emit("end");
      else this.emit("entry", this.entries[this.offset++]);
    });
  }

  close() {
    this.closed = true;
  }
}

class FakeUpload extends EventEmitter {
  constructor(options, counters) {
    super();
    this.body = options.params.Body;
    this.counters = counters;
    this.aborted = false;
    this.sequence = (this.counters.created = Number(this.counters.created || 0) + 1);
  }

  done() {
    this.counters.active += 1;
    this.counters.maximum = Math.max(this.counters.maximum, this.counters.active);
    let loaded = 0;
    return new Promise((resolve, reject) => {
      this.body.on("data", (chunk) => {
        loaded += chunk.length;
        this.emit("httpUploadProgress", { loaded });
      });
      this.body.once("error", reject);
      this.body.once("end", async () => {
        await delay(8);
        if (this.aborted) reject(new Error("aborted"));
        else if (this.sequence === this.counters.failAt) reject(new Error("simulated R2 failure"));
        else resolve({});
      });
    }).finally(() => {
      this.counters.active -= 1;
    });
  }

  abort() {
    this.aborted = true;
    this.body.destroy(new Error("aborted"));
  }
}

test("media ZIP pipeline skips durable rows and persists only new uploads in batches", async () => {
  const bodies = Array.from({ length: 8 }, (_, index) => Buffer.from(`image-${index + 1}`));
  const entries = bodies.map((body, index) => ({
    fileName: `images/${index + 1}.png`,
    uncompressedSize: body.length,
    generalPurposeBitFlag: 0,
    body,
  }));
  const references = entries.map((entry, index) => ({
    questionId: `question-${index + 1}`,
    mediaRef: entry.fileName,
    placement: "explanation",
  }));
  const existingAssets = entries.slice(0, 2).map((entry, index) => ({
    entryIndex: index + 1,
    originalName: entry.fileName,
    objectKey: `existing/${index + 1}`,
    sha256: crypto.createHash("sha256").update(entry.body).digest("hex"),
    sizeBytes: entry.body.length,
    contentType: "image/png",
    mediaKind: "image",
  }));
  const counters = { active: 0, maximum: 0 };
  const persistedBatches = [];
  const progressRows = [];
  const zip = new FakeZip(entries);
  const result = await uploadMediaZipToR2({
    zipSource: { type: "test" },
    references,
    examTrack: "usmle-step-1",
    sourceNamespace: "provider",
    importJobId: "import-job",
    mediaImportJobId: "media-job",
    inventory: {
      candidateEntries: entries.length,
      candidateUncompressedBytes: bodies.reduce((total, body) => total + body.length, 0),
    },
    existingAssets,
    concurrency: 4,
    checkpointBatchSize: 2,
    checkpointIntervalMs: 60_000,
    onProgress: async (progress) => progressRows.push(progress),
    onAssets: async (assets) => persistedBatches.push(assets.map((asset) => asset.entryIndex)),
    adapters: {
      openZip: async () => zip,
      openEntry: async (sourceZip, entry) => Readable.from(entry.body),
      r2Client: {},
      r2Bucket: "test-bucket",
      createUpload: (options) => new FakeUpload(options, counters),
    },
  });

  assert.equal(result.resumedFiles, 2);
  assert.equal(result.newlyUploaded, 6);
  assert.equal(result.assets.length, 8);
  assert.equal(result.maximumWorkersActive, 4);
  assert.equal(counters.maximum, 4);
  assert.deepEqual(persistedBatches.map((batch) => batch.length), [2, 2, 2]);
  assert.deepEqual(persistedBatches.flat().sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
  assert.equal(progressRows.at(-1).files_processed, 8);
  assert.equal(progressRows.at(-1).workers_active, 0);
  assert.equal(progressRows.at(-1).checkpoint_pending, 0);
});

test("media pipeline aborts and drains every worker before surfacing a transfer failure", async () => {
  const entries = Array.from({ length: 6 }, (_, index) => {
    const body = Buffer.from(`failure-image-${index + 1}`);
    return {
      fileName: `images/failure-${index + 1}.png`,
      uncompressedSize: body.length,
      generalPurposeBitFlag: 0,
      body,
    };
  });
  const counters = { active: 0, maximum: 0, failAt: 2 };
  const zip = new FakeZip(entries);
  await assert.rejects(() => uploadMediaZipToR2({
    zipSource: { type: "test" },
    references: entries.map((entry, index) => ({
      questionId: `question-${index + 1}`,
      mediaRef: entry.fileName,
    })),
    examTrack: "usmle-step-1",
    sourceNamespace: "provider",
    importJobId: "import-job",
    mediaImportJobId: "media-job",
    inventory: {
      candidateEntries: entries.length,
      candidateUncompressedBytes: entries.reduce((total, entry) => total + entry.body.length, 0),
    },
    concurrency: 4,
    checkpointBatchSize: 2,
    checkpointIntervalMs: 60_000,
    onAssets: async () => {},
    adapters: {
      openZip: async () => zip,
      openEntry: async (sourceZip, entry) => Readable.from(entry.body),
      r2Client: {},
      r2Bucket: "test-bucket",
      createUpload: (options) => new FakeUpload(options, counters),
    },
  }), /simulated R2 failure|aborted/);
  assert.equal(counters.active, 0);
});

test("resume validation heartbeats while durable files are skipped without re-upload", async () => {
  const entries = Array.from({ length: 600 }, (_, index) => ({
    fileName: `images/resumed-${index + 1}.png`,
    uncompressedSize: 10,
    generalPurposeBitFlag: 0,
  }));
  const existingAssets = entries.map((entry, index) => ({
    entryIndex: index + 1,
    originalName: entry.fileName,
    objectKey: `existing/${index + 1}`,
    sha256: crypto.createHash("sha256").update(entry.fileName).digest("hex"),
    sizeBytes: entry.uncompressedSize,
    contentType: "image/png",
    mediaKind: "image",
  }));
  const progressRows = [];
  let uploadsCreated = 0;
  const result = await uploadMediaZipToR2({
    zipSource: { type: "test" },
    references: entries.map((entry, index) => ({
      questionId: `question-${index + 1}`,
      mediaRef: entry.fileName,
    })),
    examTrack: "usmle-step-1",
    sourceNamespace: "provider",
    importJobId: "import-job",
    mediaImportJobId: "media-job",
    inventory: {
      candidateEntries: entries.length,
      candidateUncompressedBytes: entries.length * 10,
    },
    existingAssets,
    onProgress: async (progress) => progressRows.push(progress),
    adapters: {
      openZip: async () => new FakeZip(entries),
      openEntry: async () => {
        throw new Error("durable entries must not be reopened");
      },
      r2Client: {},
      r2Bucket: "test-bucket",
      createUpload: () => {
        uploadsCreated += 1;
        throw new Error("durable entries must not be re-uploaded");
      },
    },
  });

  const validation = progressRows.find((progress) => (
    progress.stage === "validating_media_resume"
    && progress.recovery_entries_scanned >= 500
    && progress.resumed_files_validated >= 500
  ));
  assert.ok(validation, "expected a resume-validation progress heartbeat");
  assert.equal(uploadsCreated, 0);
  assert.equal(result.resumedFiles, 600);
  assert.equal(result.newlyUploaded, 0);
});
