import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { SafeBackgroundQueue } from "../lib/safe-background-jobs.js";
import { ResumableContentUploadStore } from "../lib/resumable-content-upload.js";
import { importUniversalQuestionZip } from "../lib/content-zip-import.js";
import { storagePerformanceSnapshot } from "../lib/operations-monitoring.js";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(check, timeoutMs = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for background state");
}

test("v217 persistent queue bounds concurrency and resumes from checkpoints", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-jobs-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let active = 0;
  let maximumActive = 0;
  const attempts = new Map();
  const queue = new SafeBackgroundQueue({ directory, maxConcurrency: 1, retryBaseMs: 10, memoryRetryMs: 10 });
  queue.register("import", async ({ job, updateCheckpoint }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      const attempt = (attempts.get(job.id) || 0) + 1;
      attempts.set(job.id, attempt);
      if (job.metadata.retry_once && attempt === 1) {
        await updateCheckpoint({ offset: 10 }, { imported: 10 });
        throw new Error("temporary provider failure");
      }
      if (job.metadata.retry_once) assert.equal(job.checkpoint.offset, 10);
      await new Promise((resolve) => setTimeout(resolve, 15));
    } finally {
      active -= 1;
    }
  });
  await queue.enqueue({ id: crypto.randomUUID(), type: "import", lane: "question_zip", metadata: { retry_once: true }, maxAttempts: 2 });
  await queue.enqueue({ id: crypto.randomUUID(), type: "import", lane: "image_zip" });
  await waitFor(() => queue.summary().counts.completed === 2 && queue.summary().active === 0);
  assert.equal(maximumActive, 1);
  assert.equal(queue.summary().active, 0);
  const retried = queue.list({ limit: 10 }).find((job) => job.metadata.retry_once);
  assert.equal(retried.attempts, 2);
  assert.deepEqual(retried.checkpoint, { offset: 10 });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "jobs.json"), "utf8"));
  assert.equal(manifest.jobs.length, 2);
  assert.equal(JSON.stringify(manifest).includes("Buffer"), false);
});

test("v217 queue recovers an interrupted persisted job when its input remains", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-recovery-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "input.zip");
  await fs.writeFile(input, "zip-bytes");
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await fs.writeFile(path.join(directory, "jobs.json"), JSON.stringify({ version: 1, jobs: [{
    id, type: "recover", lane: "question_zip", status: "running", priority: 0,
    attempts: 1, max_attempts: 3, idempotency_key: "", payload: { file: input }, metadata: {},
    progress: {}, checkpoint: { pair_index: 2 }, error: null, interrupted_count: 0,
    created_at: timestamp, updated_at: timestamp, queued_at: timestamp, started_at: timestamp,
    heartbeat_at: timestamp, finished_at: null, next_retry_at: null,
  }] }, null, 2));
  let recoveredCheckpoint;
  const queue = new SafeBackgroundQueue({ directory, maxConcurrency: 1 });
  queue.register("recover", async ({ job }) => { recoveredCheckpoint = job.checkpoint; }, {
    canRecover: async (job) => fs.access(job.payload.file).then(() => true).catch(() => false),
  });
  await queue.initialize();
  await waitFor(() => queue.get(id)?.status === "completed");
  assert.deepEqual(recoveredCheckpoint, { pair_index: 2 });
  assert.equal(queue.get(id).interrupted_count, 1);
});

test("recovery queue keeps only a bounded terminal working set while preserving authoritative history", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-retention-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const timestamp = new Date("2026-07-28T10:00:00.000Z");
  const rows = new Map(Array.from({ length: 61 }, (_, index) => {
    const updated = new Date(timestamp.getTime() + index * 1000).toISOString();
    const status = index === 60 ? "paused" : "completed";
    const id = `job-${String(index).padStart(3, "0")}`;
    return [id, {
      id,
      type: "import",
      lane: "question_zip",
      status,
      priority: 0,
      attempts: 1,
      max_attempts: 3,
      idempotency_key: "",
      payload: { domain_job_id: `domain-${index}` },
      metadata: {},
      progress: { completed: status === "completed" },
      checkpoint: {},
      error: null,
      interrupted_count: 0,
      created_at: updated,
      updated_at: updated,
      queued_at: updated,
      started_at: updated,
      heartbeat_at: updated,
      finished_at: status === "completed" ? updated : null,
      next_retry_at: null,
    }];
  }));
  const store = {
    kind: "postgres",
    async load() { return [...rows.values()].map((row) => structuredClone(row)); },
    async save(job) { rows.set(job.id, structuredClone(job)); },
  };
  const queue = new SafeBackgroundQueue({
    directory,
    persistentStore: store,
    maxRetainedTerminalJobs: 20,
  });
  await queue.initialize();
  const summary = queue.summary();
  assert.equal(summary.recovery_source, "postgres");
  assert.equal(summary.retained_terminal_jobs, 20);
  assert.equal(summary.retained_jobs, 21);
  assert.equal(summary.pruned_terminal_jobs, 40);
  assert.equal(rows.size, 61);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "jobs.json"), "utf8"));
  assert.equal(manifest.jobs.length, 21);
  assert.ok(manifest.jobs.some((job) => job.status === "paused"));
});

test("authoritative recovery bypasses an oversized disk manifest and rewrites a bounded copy", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-authoritative-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "jobs.json"), "x".repeat(2 * 1024 * 1024));
  const timestamp = new Date().toISOString();
  const store = {
    kind: "postgres",
    async load() {
      return [{
        id: "authoritative-1",
        type: "import",
        lane: "question_zip",
        status: "completed",
        priority: 0,
        attempts: 1,
        max_attempts: 3,
        idempotency_key: "",
        payload: {},
        metadata: {},
        progress: { completed: true },
        checkpoint: {},
        error: null,
        interrupted_count: 0,
        created_at: timestamp,
        updated_at: timestamp,
        queued_at: timestamp,
        started_at: timestamp,
        heartbeat_at: timestamp,
        finished_at: timestamp,
        next_retry_at: null,
      }];
    },
    async save() {},
  };
  const queue = new SafeBackgroundQueue({
    directory,
    persistentStore: store,
    maxManifestReadBytes: 1024 * 1024,
  });
  await queue.initialize();
  assert.equal(queue.summary().recovery_source, "postgres");
  assert.equal(queue.summary().disk_manifest_skipped, null);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "jobs.json"), "utf8"));
  assert.deepEqual(manifest.jobs.map((job) => job.id), ["authoritative-1"]);
});

test("oversized disk fallback is skipped safely when the authoritative store is unavailable", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-disk-limit-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "jobs.json"), "x".repeat(2 * 1024 * 1024));
  const warnings = [];
  const queue = new SafeBackgroundQueue({
    directory,
    persistentStore: {
      kind: "postgres",
      async load() { throw new Error("temporary database outage"); },
      async save() {},
    },
    maxManifestReadBytes: 1024 * 1024,
    logger: {
      warn(...values) { warnings.push(values.join(" ")); },
      error() {},
    },
  });
  await queue.initialize();
  assert.equal(queue.summary().recovery_source, "disk");
  assert.equal(queue.summary().disk_manifest_skipped.reason, "oversized_recovery_manifest");
  assert.ok(warnings.some((message) => message.includes("safe read limit")));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "jobs.json"), "utf8"));
  assert.deepEqual(manifest.jobs, []);
});

test("v217 queue pauses at a heartbeat, resumes safely, and honors the memory gate", async (t) => {
  const directory = await temporaryDirectory("nextgen-safe-controls-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let memoryHigh = true;
  let executions = 0;
  let announceStarted;
  let releaseFirst;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = new SafeBackgroundQueue({
    directory, maxConcurrency: 1, memoryRetryMs: 10, memoryGate: () => memoryHigh,
  });
  queue.register("controlled", async ({ heartbeat }) => {
    executions += 1;
    if (executions === 1) {
      announceStarted();
      await firstGate;
      await heartbeat({ stage: "checkpoint_boundary" });
    }
  });
  const id = crypto.randomUUID();
  await queue.enqueue({ id, type: "controlled" });
  await waitFor(() => queue.summary().memory_pauses > 0);
  assert.equal(queue.get(id).status, "queued");
  memoryHigh = false;
  queue.kick();
  await started;
  await queue.pause(id);
  releaseFirst();
  await waitFor(() => queue.get(id).status === "paused");
  await queue.resume(id);
  await waitFor(() => queue.get(id).status === "completed" && queue.summary().active === 0);
  assert.equal(executions, 2);
});

test("v254 memory gate can pause one lane without blocking safe work", async (t) => {
  const directory = await temporaryDirectory("nextgen-lane-memory-gate-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let vimeoMemoryHigh = true;
  const executions = [];
  const queue = new SafeBackgroundQueue({
    directory,
    maxConcurrency: 2,
    laneConcurrency: { ayla_vimeo_ai: 1, question_zip: 1 },
    memoryRetryMs: 10,
    memoryGate: (job) => job?.lane === "ayla_vimeo_ai" && vimeoMemoryHigh,
  });
  queue.register("controlled", async ({ job }) => {
    executions.push(job.lane);
  });
  const vimeoId = crypto.randomUUID();
  const questionId = crypto.randomUUID();
  await queue.enqueue({
    id: vimeoId,
    type: "controlled",
    lane: "ayla_vimeo_ai",
    priority: 10,
  });
  await queue.enqueue({
    id: questionId,
    type: "controlled",
    lane: "question_zip",
    priority: 0,
  });
  await waitFor(() => queue.get(questionId)?.status === "completed");
  assert.deepEqual(executions, ["question_zip"]);
  assert.equal(queue.get(vimeoId).status, "queued");
  assert.ok(queue.summary().memory_pauses > 0);
  assert.equal(queue.summary().lane_concurrency.ayla_vimeo_ai, 1);

  vimeoMemoryHigh = false;
  queue.kick();
  await waitFor(() => queue.get(vimeoId)?.status === "completed");
  assert.deepEqual(executions, ["question_zip", "ayla_vimeo_ai"]);
});

test("v217 resumable ZIP store streams chunks, verifies hashes, leases, and finalization", async (t) => {
  const directory = await temporaryDirectory("nextgen-resumable-upload-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = crypto.randomBytes(600_123);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const store = new ResumableContentUploadStore({
    directory,
    chunkSize: 256 * 1024,
    maxChunkBytes: 256 * 1024,
    maxUploadBytes: 2 * 1024 * 1024,
  });
  const session = await store.create({
    originalFilename: "questions.zip",
    totalBytes: bytes.length,
    expectedSha256: digest,
    purpose: "question_zip",
    createdBy: "admin-1",
    metadata: { exam_track: "usmle-step-1" },
  });
  assert.equal(session.chunk_count, 3);
  for (let index = 0; index < session.chunk_count; index += 1) {
    const start = index * session.chunk_size;
    const chunk = bytes.subarray(start, Math.min(bytes.length, start + session.chunk_size));
    const chunkDigest = crypto.createHash("sha256").update(chunk).digest("hex");
    const result = await store.writeChunk(session.id, index, Readable.from(chunk), {
      contentLength: chunk.length,
      expectedSha256: chunkDigest,
    });
    assert.equal(result.chunk.sha256, chunkDigest);
    if (index === 0) {
      const duplicate = await store.writeChunk(session.id, index, Readable.from(chunk), {
        contentLength: chunk.length,
        expectedSha256: chunkDigest,
      });
      assert.equal(duplicate.deduplicated, true);
    }
  }
  const finalized = await store.finalize(session.id);
  assert.equal(finalized.sha256, digest);
  assert.deepEqual(await fs.readFile(finalized.file), bytes);
  const resolved = await store.resolveFinalized(session.id, { allowedPurposes: ["question_zip"] });
  assert.equal(resolved.sha256, digest);
  await store.acquire(session.id, "job-1");
  await assert.rejects(() => store.cancel(session.id), /in use/);
  await store.release(session.id, "job-1");
  const cancelled = await store.cancel(session.id);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => store.get(session.id), /not found/);

  const wrongHashBytes = Buffer.from("not-the-declared-zip");
  const wrongHash = await store.create({
    originalFilename: "wrong.zip", totalBytes: wrongHashBytes.length,
    expectedSha256: "0".repeat(64), purpose: "question_zip", createdBy: "admin-1",
  });
  await store.writeChunk(wrongHash.id, 0, Readable.from(wrongHashBytes), { contentLength: wrongHashBytes.length });
  await assert.rejects(() => store.finalize(wrongHash.id), /SHA-256 does not match/);
});

test("v217 question import resumes after the last committed batch checkpoint", async (t) => {
  const directory = await temporaryDirectory("nextgen-import-checkpoint-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const questionFile = path.join(directory, "questions.json");
  const answerFile = path.join(directory, "answers.json");
  const questions = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    question: `<p>Question ${index + 1}?</p>`,
    explanation: `Explanation ${index + 1}`,
    corrAns: 1,
  }));
  const answers = questions.flatMap((question) => [
    { qId: question.id, answerId: 1, answerText: "Correct" },
    { qId: question.id, answerId: 2, answerText: "Distractor" },
  ]);
  await fs.writeFile(questionFile, JSON.stringify(questions));
  await fs.writeFile(answerFile, JSON.stringify(answers));
  const inventory = {
    names: ["set_questions.json", "set_answers.json"],
    extractedJson: new Map([["set_questions.json", questionFile], ["set_answers.json", answerFile]]),
  };
  const job = {
    id: crypto.randomUUID(), exam_track: "usmle-step-1", source_namespace: "provider-a",
    source_provider: "Provider A", collection_title: "Checkpoint set", destinations: [],
  };
  let checkpoint;
  let batch = 0;
  await assert.rejects(() => importUniversalQuestionZip({
    inventory, job, batchSize: 10,
    onBatch: async ({ rows }) => {
      batch += 1;
      if (batch === 2) throw new Error("simulated interruption");
      return { created: rows.length, answers: rows.length * 2 };
    },
    onCheckpoint: async (next) => { checkpoint = structuredClone(next); },
  }), /simulated interruption/);
  assert.equal(checkpoint.questions_processed_in_pair, 10);

  const resumedSourceIds = [];
  const progressSnapshots = [];
  const resumed = await importUniversalQuestionZip({
    inventory, job: { ...job, counts: { questions_seen: 25 } }, batchSize: 10, checkpoint,
    onBatch: async ({ rows }) => {
      resumedSourceIds.push(...rows.map((row) => Number(row.sourceItemId)));
      return { created: rows.length, answers: rows.length * 2 };
    },
    onCheckpoint: async (_next, progress) => progressSnapshots.push(progress),
  });
  assert.deepEqual(resumedSourceIds, Array.from({ length: 15 }, (_, index) => index + 11));
  assert.equal(resumed.totals.questions_seen, 25);
  assert.equal(resumed.totals.collections, 1);
  assert.equal(progressSnapshots.at(-1).questions_processed, 25);
  assert.equal(progressSnapshots.at(-1).questions_total, 25);
  assert.equal(progressSnapshots.at(-1).percent, 99);
});

test("v217 operational snapshot reports bounded disk/process safety without secrets", async (t) => {
  const directory = await temporaryDirectory("nextgen-operations-snapshot-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "content"));
  await fs.writeFile(path.join(directory, "content", "manifest.json"), "{}\n");
  const snapshot = await storagePerformanceSnapshot({
    dataDir: directory,
    roots: { content: path.join(directory, "content") },
    memory: { rss_mb: 10 },
    storage: { postgres: { configured: false } },
  });
  assert.equal(snapshot.roots.content.files, 1);
  assert.equal(snapshot.safety.binary_uploads_in_postgres, false);
  assert.equal(snapshot.safety.question_imports_run_in_student_requests, false);
  assert.equal(snapshot.safety.correct_answers_server_only_until_submission, true);
});

test("v217 server exposes only admin operations routes and advances the Ayla schema", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const monitoring = await fs.readFile(new URL("../lib/operations-monitoring.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-multiexam-publication-taxonomy-v220"/);
  assert.match(server, /schema_version: 15/);
  assert.match(server, /app\.post\("\/admin\/crm\/ai-training\/content-uploads"/);
  assert.match(server, /app\.put\("\/admin\/crm\/ai-training\/content-uploads\/:uploadId\/chunks\/:index"/);
  assert.match(server, /app\.post\("\/admin\/crm\/ai-training\/content-uploads\/:uploadId\/finalize"/);
  assert.match(server, /app\.put\("\/admin\/crm\/ai-training\/content-uploads\/:uploadId\/parts\/:index"/);
  assert.match(server, /transport: "render_r2_relay"/);
  assert.match(server, /Part Content-Length is required/);
  assert.match(server, /isAuthorizedExternalMedia[\s\S]*purpose[\s\S]*media_zip[\s\S]*ngAuthorizedExternalImportSource\(metadata\)/);
  assert.match(server, /parentAllowed = ngOwnedAylaMedImportJob\(parentJob\)[\s\S]*ngAuthorizedExternalImportSource\(parentJob\)/);
  assert.match(server, /app\.get\("\/admin\/crm\/operations\/content-jobs"/);
  assert.match(server, /app\.get\("\/admin\/crm\/operations\/storage-performance"/);
  assert.match(server, /requireCrmAdmin\(req\)/);
  assert.match(monitoring, /correct_answers_server_only_until_submission: true/);
  assert.doesNotMatch(server, /void ngRunContent(?:ImportPreview|DraftImport|MediaDraftImport|VideoDraftImport)/);
});
