import assert from "node:assert/strict";
import test from "node:test";
import {
  guardedUworldArchiveFingerprint,
  inspectGuardedUworldArchives,
} from "../lib/guarded-uworld-archive.js";

const bytes = Math.floor(8.68 * 1024 ** 3);
const key = "content-staging/legacy/Uworld 1.zip";
const etag = "legacy-multipart-etag";
const fingerprint = guardedUworldArchiveFingerprint({ objectKey: key, sizeBytes: bytes, etag });

function exactJob(overrides = {}) {
  return {
    id: "background-job-1",
    status: "completed",
    metadata: {
      domain_job_id: "22913b91-4e8d-4a1f-b6a6-b09c94763cdc",
      original_filename: "Uworld 1.zip",
      purpose: "media_zip",
    },
    payload: {
      upload_id: "upload-1",
      source: { type: "r2", objectKey: key, sizeBytes: bytes, etag },
    },
    ...overrides,
  };
}

test("archive inspection recovers the exact media ZIP from job lineage and live R2 metadata", async () => {
  const result = await inspectGuardedUworldArchives({
    uploads: [{
      id: "upload-1",
      original_filename: "Uworld 1.zip",
      object_key: key,
      total_bytes: 0,
      status: "finalized",
      purpose: "media_zip",
      active_leases: 0,
    }],
    jobs: [exactJob()],
    expectedFingerprints: [fingerprint],
    headObject: async () => ({ sizeBytes: bytes, etag }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.archive.object_key, key);
  assert.equal(result.archive.total_bytes, bytes);
  assert.equal(result.archive.fingerprint, fingerprint);
  assert.equal(result.archive.checks.exact_job_identity, true);
});

test("archive inspection recovers from persisted job lineage when the upload manifest expired", async () => {
  const result = await inspectGuardedUworldArchives({
    jobs: [exactJob()],
    expectedFingerprints: [fingerprint],
    headObject: async () => ({ sizeBytes: bytes, etag }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.archive.object_key, key);
  assert.deepEqual(result.archive.sources, ["exact_job_lineage"]);
  assert.deepEqual(result.archive.upload_ids, ["upload-1"]);
});

test("archive inspection blocks active leases and active exact jobs", async () => {
  const result = await inspectGuardedUworldArchives({
    uploads: [{
      id: "upload-1",
      original_filename: "Uworld 1.zip",
      object_key: key,
      total_bytes: bytes,
      status: "finalized",
      purpose: "question_zip",
      active_leases: 1,
    }],
    jobs: [exactJob({ status: "running" })],
    expectedFingerprints: [fingerprint],
    headObject: async () => ({ sizeBytes: bytes, etag }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.candidates[0].checks.no_active_leases, false);
  assert.equal(result.candidates[0].checks.no_active_jobs, false);
});

test("archive inspection blocks an R2 object whose live identity differs", async () => {
  const result = await inspectGuardedUworldArchives({
    jobs: [exactJob()],
    expectedFingerprints: [fingerprint],
    headObject: async () => ({ sizeBytes: bytes - 1, etag: "different" }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.candidates[0].checks.exact_job_identity, false);
  assert.equal(result.candidates[0].checks.declared_size_exact, false);
});

test("archive inspection fails closed when two exact legacy archives remain", async () => {
  const secondKey = "content-staging/legacy-copy/Uworld 1.zip";
  const secondEtag = "second-etag";
  const secondFingerprint = guardedUworldArchiveFingerprint({
    objectKey: secondKey,
    sizeBytes: bytes,
    etag: secondEtag,
  });
  const result = await inspectGuardedUworldArchives({
    uploads: [
      {
        id: "upload-1",
        original_filename: "Uworld 1.zip",
        object_key: key,
        total_bytes: bytes,
        status: "finalized",
        purpose: "question_zip",
      },
      {
        id: "upload-2",
        original_filename: "Uworld 1.zip",
        object_key: secondKey,
        total_bytes: bytes,
        status: "finalized",
        purpose: "media_zip",
      },
    ],
    expectedFingerprints: [fingerprint, secondFingerprint],
    headObject: async (objectKey) => ({
      sizeBytes: bytes,
      etag: objectKey === key ? etag : secondEtag,
    }),
  });
  assert.equal(result.exact.length, 2);
  assert.equal(result.ready, false);
  assert.equal(result.archive, null);
});
