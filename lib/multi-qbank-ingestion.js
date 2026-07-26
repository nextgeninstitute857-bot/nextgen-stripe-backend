export const MULTI_QBANK_INGESTION_BUILD = "v242-cached-video-entry-streaming";

const ACTIVE_JOB_STATUSES = new Set([
  "queued",
  "running",
  "retry_wait",
  "pause_requested",
  "cancel_requested",
]);
const FAILURE_STATUSES = new Set([
  "failed",
  "queue_failed",
  "preview_failed",
  "draft_import_failed",
  "draft_import_retrying",
]);
const WARNING_STATUSES = new Set([
  "preview_with_warnings",
  "draft_imported_with_warnings",
  "completed_with_warnings",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function boundedPercent(value, fallback, minimum = 1, maximum = 99) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function cleanStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function multiQbankIngestionConfig(source = process.env) {
  const mediaWorkersPerJob = boundedInteger(
    source.NEXTGEN_CONTENT_MEDIA_CONCURRENCY,
    8,
    1,
    12,
  );
  const mediaJobs = boundedInteger(
    source.NEXTGEN_CONTENT_MEDIA_JOB_CONCURRENCY,
    2,
    1,
    4,
  );
  const globalTransferDefault = Math.min(24, Math.max(
    mediaWorkersPerJob,
    Math.min(mediaWorkersPerJob * mediaJobs, 12),
  ));
  const memorySoftPercent = boundedPercent(
    source.NEXTGEN_BACKGROUND_MEMORY_SOFT_PERCENT,
    70,
    50,
    90,
  );
  const memoryHardPercent = boundedPercent(
    source.NEXTGEN_CONTENT_MEMORY_HARD_PERCENT,
    Math.max(82, memorySoftPercent + 5),
    memorySoftPercent + 1,
    95,
  );
  return {
    build: MULTI_QBANK_INGESTION_BUILD,
    max_active_jobs: boundedInteger(
      source.NEXTGEN_CONTENT_JOB_CONCURRENCY,
      4,
      1,
      8,
    ),
    lane_concurrency: {
      question_zip: boundedInteger(
        source.NEXTGEN_CONTENT_QUESTION_JOB_CONCURRENCY,
        2,
        1,
        4,
      ),
      image_zip: mediaJobs,
      video_zip: boundedInteger(
        source.NEXTGEN_CONTENT_VIDEO_JOB_CONCURRENCY,
        2,
        1,
        4,
      ),
      ayla_vimeo_ai: 1,
    },
    media_workers_per_job: mediaWorkersPerJob,
    media_global_transfer_limit: boundedInteger(
      source.NEXTGEN_CONTENT_GLOBAL_MEDIA_CONCURRENCY,
      globalTransferDefault,
      1,
      24,
    ),
    media_min_transfer_limit: boundedInteger(
      source.NEXTGEN_CONTENT_MIN_MEDIA_CONCURRENCY,
      Math.min(4, globalTransferDefault),
      1,
      globalTransferDefault,
    ),
    postgres_finalizers: 1,
    media_finalization_batch_size: boundedInteger(
      source.NEXTGEN_CONTENT_MEDIA_FINALIZATION_BATCH_SIZE,
      1_000,
      25,
      1_000,
    ),
    vimeo_uploads: boundedInteger(
      source.NEXTGEN_CONTENT_VIMEO_UPLOAD_CONCURRENCY,
      2,
      1,
      4,
    ),
    vimeo_rate_limit_attempts: boundedInteger(
      source.NEXTGEN_CONTENT_VIMEO_RATE_LIMIT_ATTEMPTS,
      6,
      1,
      8,
    ),
    memory_soft_percent: memorySoftPercent,
    memory_hard_percent: memoryHardPercent,
    job_lease_ms: boundedInteger(
      source.NEXTGEN_CONTENT_JOB_LEASE_MS,
      120_000,
      30_000,
      10 * 60 * 1000,
    ),
    postgres_job_state: String(source.DATABASE_URL || "").trim()
      ? "authoritative_with_disk_recovery_copy"
      : "disk_only_until_postgres_is_configured",
  };
}

function errorStatus(error) {
  return Number(
    error?.statusCode
    || error?.status
    || error?.response?.status
    || 0,
  );
}

export function isProviderRateLimit(error) {
  return errorStatus(error) === 429;
}

export function providerRetryAfterMs(error, {
  fallbackMs = 1_000,
  maximumMs = 15 * 60 * 1000,
  nowMs = Date.now(),
} = {}) {
  const headers = error?.response?.headers || error?.headers || {};
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  let requested = 0;
  if (raw !== undefined && raw !== null && raw !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) requested = Math.max(0, seconds * 1000);
    else {
      const date = Date.parse(String(raw));
      if (Number.isFinite(date)) requested = Math.max(0, date - Number(nowMs));
    }
  }
  const reset = Number(
    headers["x-ratelimit-reset"]
    ?? headers["X-RateLimit-Reset"]
    ?? 0,
  );
  if (!requested && Number.isFinite(reset) && reset > 0) {
    const resetMs = reset > 10_000_000_000 ? reset : reset * 1000;
    requested = Math.max(0, resetMs - Number(nowMs));
  }
  return Math.max(
    50,
    Math.min(
      Math.max(50, Number(maximumMs) || 15 * 60 * 1000),
      requested || Math.max(50, Number(fallbackMs) || 1_000),
    ),
  );
}

export async function withProviderRateLimitBackoff(operation, {
  maxAttempts = 6,
  baseDelayMs = 1_000,
  maximumDelayMs = 15 * 60 * 1000,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random = Math.random,
  onRetry,
} = {}) {
  if (typeof operation !== "function") throw new Error("A provider operation is required");
  const attempts = boundedInteger(maxAttempts, 6, 1, 8);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation({ attempt, maxAttempts: attempts });
    } catch (error) {
      lastError = error;
      if (!isProviderRateLimit(error) || attempt >= attempts) throw error;
      const exponential = Math.min(
        maximumDelayMs,
        Math.max(50, Number(baseDelayMs) || 1_000) * (2 ** (attempt - 1)),
      );
      const providerDelay = providerRetryAfterMs(error, {
        fallbackMs: exponential,
        maximumMs: maximumDelayMs,
      });
      const jitter = Math.floor(Math.max(0, Number(random?.() || 0)) * Math.min(1_000, providerDelay * 0.1));
      const delayMs = Math.min(maximumDelayMs, providerDelay + jitter);
      await onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError || new Error("Provider operation failed");
}

/**
 * Shared FIFO capacity gate used across independent QBank jobs.
 *
 * The configured limit is reduced for new work when process memory rises or a
 * provider starts rejecting requests. Active streams are allowed to finish.
 */
export class AdaptiveCapacityGate {
  constructor({
    name = "capacity",
    minimum = 1,
    normal = 1,
    maximum = normal,
    memorySoftPercent = 70,
    memoryHardPercent = 82,
    memoryProvider = () => null,
    now = () => Date.now(),
  } = {}) {
    this.name = String(name || "capacity");
    this.maximum = boundedInteger(maximum, 1, 1, 64);
    this.minimum = boundedInteger(minimum, 1, 1, this.maximum);
    this.normal = boundedInteger(normal, this.maximum, this.minimum, this.maximum);
    this.target = this.normal;
    this.memorySoftPercent = boundedPercent(memorySoftPercent, 70, 1, 98);
    this.memoryHardPercent = boundedPercent(
      memoryHardPercent,
      Math.max(82, this.memorySoftPercent + 1),
      this.memorySoftPercent + 1,
      99,
    );
    this.memoryProvider = typeof memoryProvider === "function" ? memoryProvider : () => null;
    this.now = now;
    this.active = 0;
    this.maximumActive = 0;
    this.pending = [];
    this.successStreak = 0;
    this.failureStreak = 0;
    this.rateLimitedUntil = 0;
    this.lastRateLimitAt = null;
    this.lastFailureAt = null;
  }

  memoryPercent() {
    const snapshot = this.memoryProvider?.() || {};
    const percent = Number(snapshot.percent ?? snapshot.memory_percent);
    return Number.isFinite(percent) ? percent : null;
  }

  effectiveLimit() {
    let limit = this.target;
    const memoryPercent = this.memoryPercent();
    if (memoryPercent !== null && memoryPercent >= this.memoryHardPercent) {
      limit = this.minimum;
    } else if (memoryPercent !== null && memoryPercent >= this.memorySoftPercent) {
      limit = Math.max(this.minimum, Math.ceil(limit / 2));
    }
    if (this.rateLimitedUntil > this.now()) limit = this.minimum;
    return Math.max(this.minimum, Math.min(this.maximum, limit));
  }

  snapshot() {
    return {
      name: this.name,
      active: this.active,
      pending: this.pending.filter((ticket) => !ticket.settled).length,
      configured_minimum: this.minimum,
      configured_normal: this.normal,
      configured_maximum: this.maximum,
      adaptive_target: this.target,
      effective_limit: this.effectiveLimit(),
      maximum_active_observed: this.maximumActive,
      memory_percent: this.memoryPercent(),
      memory_soft_percent: this.memorySoftPercent,
      memory_hard_percent: this.memoryHardPercent,
      rate_limited_until: this.rateLimitedUntil > this.now()
        ? new Date(this.rateLimitedUntil).toISOString()
        : null,
      last_rate_limit_at: this.lastRateLimitAt,
      last_failure_at: this.lastFailureAt,
    };
  }

  observeResult(error = null) {
    if (!error) {
      this.failureStreak = 0;
      this.successStreak += 1;
      if (
        this.successStreak >= 25
        && this.rateLimitedUntil <= this.now()
        && (this.memoryPercent() === null || this.memoryPercent() < this.memorySoftPercent)
        && this.target < this.normal
      ) {
        this.target += 1;
        this.successStreak = 0;
      }
      this.pump();
      return;
    }
    this.successStreak = 0;
    this.failureStreak += 1;
    this.lastFailureAt = new Date(this.now()).toISOString();
    if (isProviderRateLimit(error)) {
      const delayMs = providerRetryAfterMs(error, { fallbackMs: 30_000, nowMs: this.now() });
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + delayMs);
      this.lastRateLimitAt = this.lastFailureAt;
      this.target = Math.max(this.minimum, this.target - 1);
    } else if (this.failureStreak >= 3) {
      this.target = Math.max(this.minimum, this.target - 1);
      this.failureStreak = 0;
    }
    this.pump();
  }

  async acquire({
    onWait,
    waitHeartbeatMs = 15_000,
    signal,
    metadata = {},
  } = {}) {
    if (signal?.aborted) throw signal.reason || new Error("Capacity wait aborted");
    return new Promise((resolve, reject) => {
      const ticket = {
        settled: false,
        metadata: clone(metadata || {}),
        timer: null,
        abortHandler: null,
        resolve,
        reject,
      };
      const remove = () => {
        const index = this.pending.indexOf(ticket);
        if (index >= 0) this.pending.splice(index, 1);
      };
      const fail = (error) => {
        if (ticket.settled) return;
        ticket.settled = true;
        clearInterval(ticket.timer);
        signal?.removeEventListener?.("abort", ticket.abortHandler);
        remove();
        reject(error);
        this.pump();
      };
      const pulse = async () => {
        if (ticket.settled || typeof onWait !== "function") return;
        try {
          await onWait({
            ...this.snapshot(),
            queue_position: Math.max(1, this.pending.indexOf(ticket) + 1),
            metadata: clone(ticket.metadata),
          });
        } catch (error) {
          fail(error);
        }
      };
      ticket.grant = () => {
        if (ticket.settled) return;
        ticket.settled = true;
        clearInterval(ticket.timer);
        signal?.removeEventListener?.("abort", ticket.abortHandler);
        this.active += 1;
        this.maximumActive = Math.max(this.maximumActive, this.active);
        let released = false;
        resolve(({ error = null } = {}) => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          this.observeResult(error);
          this.pump();
        });
      };
      ticket.abortHandler = () => fail(signal.reason || new Error("Capacity wait aborted"));
      signal?.addEventListener?.("abort", ticket.abortHandler, { once: true });
      if (typeof onWait === "function") {
        ticket.timer = setInterval(() => { void pulse(); }, Math.max(1_000, Number(waitHeartbeatMs) || 15_000));
        ticket.timer.unref?.();
      }
      this.pending.push(ticket);
      this.pump();
      if (!ticket.settled) void pulse();
    });
  }

  pump() {
    const limit = this.effectiveLimit();
    while (this.active < limit && this.pending.length) {
      const ticket = this.pending.shift();
      if (!ticket || ticket.settled) continue;
      ticket.grant();
    }
  }
}

function publicDomainJob(row, kind) {
  if (!row) return null;
  return {
    id: row.id,
    kind,
    status: row.status,
    original_filename: row.original_filename || null,
    counts: clone(row.counts || {}),
    errors: clone(Array.isArray(row.errors) ? row.errors.slice(0, 20) : []),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function pipelineStatus(question, imageJobs, videoJobs, backgroundJobs) {
  const queueStatuses = backgroundJobs.map((job) => cleanStatus(job.status));
  const domainStatuses = [
    question?.status,
    ...imageJobs.map((job) => job.status),
    ...videoJobs.map((job) => job.status),
  ].map(cleanStatus);
  if (queueStatuses.some((status) => status === "running")) return "running";
  if (queueStatuses.some((status) => status === "pause_requested" || status === "paused")) return "paused";
  if (queueStatuses.some((status) => status === "retry_wait")) return "retry_wait";
  if (queueStatuses.some((status) => status === "queued")) return "queued";
  if (
    queueStatuses.some((status) => status === "failed")
    || domainStatuses.some((status) => FAILURE_STATUSES.has(status) || /(?:^|_)failed$/.test(status))
  ) return "failed";
  if (domainStatuses.some((status) => WARNING_STATUSES.has(status))) return "completed_with_warnings";
  if (domainStatuses.some((status) => /uploading|importing|previewing|indexing|saving/.test(status))) return "running";
  if (question && /draft_imported/.test(cleanStatus(question.status))) return "ready";
  return cleanStatus(question?.status) || "unknown";
}

function newestActiveBackgroundJob(rows = []) {
  return [...rows]
    .filter((job) => ACTIVE_JOB_STATUSES.has(cleanStatus(job.status)))
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))[0]
    || [...rows].sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))[0]
    || null;
}

export function buildQbankIngestionDashboard({
  registryJobs = {},
  backgroundJobs = [],
  controlPlane = {},
} = {}) {
  const questionJobs = Array.isArray(registryJobs?.question_imports)
    ? registryJobs.question_imports
    : [];
  const imageJobs = Array.isArray(registryJobs?.image_imports)
    ? registryJobs.image_imports
    : [];
  const videoJobs = Array.isArray(registryJobs?.video_imports)
    ? registryJobs.video_imports
    : [];
  const safeBackgroundJobs = (Array.isArray(backgroundJobs) ? backgroundJobs : [])
    .map((job) => ({
      id: job.id,
      type: job.type,
      lane: job.lane,
      status: job.status,
      priority: job.priority,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      progress: clone(job.progress || {}),
      error: job.error || null,
      domain_job_id: job.metadata?.domain_job_id || null,
      heartbeat_at: job.heartbeat_at || null,
      created_at: job.created_at || null,
      updated_at: job.updated_at || null,
    }));
  const domainToParent = new Map();
  for (const row of questionJobs) domainToParent.set(String(row.id), String(row.id));
  for (const row of [...imageJobs, ...videoJobs]) {
    domainToParent.set(String(row.id), String(row.content_import_job_id));
  }
  const queueByParent = new Map();
  const orphanBackgroundJobs = [];
  for (const job of safeBackgroundJobs) {
    const parentId = domainToParent.get(String(job.domain_job_id || ""));
    if (!parentId) {
      orphanBackgroundJobs.push(job);
      continue;
    }
    if (!queueByParent.has(parentId)) queueByParent.set(parentId, []);
    queueByParent.get(parentId).push(job);
  }
  const pipelines = questionJobs.map((question) => {
    const parentId = String(question.id);
    const images = imageJobs.filter((job) => String(job.content_import_job_id) === parentId);
    const videos = videoJobs.filter((job) => String(job.content_import_job_id) === parentId);
    const queue = queueByParent.get(parentId) || [];
    const active = newestActiveBackgroundJob(queue);
    return {
      id: question.id,
      collection_title: question.collection_title,
      exam_track: question.exam_track,
      source_namespace: question.source_namespace,
      source_provider: question.source_provider,
      status: pipelineStatus(question, images, videos, queue),
      current_stage: active?.progress?.stage || null,
      progress: clone(active?.progress || {}),
      question_import: publicDomainJob(question, "questions"),
      image_imports: images.map((job) => publicDomainJob(job, "images_audio")),
      video_imports: videos.map((job) => publicDomainJob(job, "videos")),
      background_jobs: queue,
      warnings: [
        ...(Array.isArray(question.errors) ? question.errors : []),
        ...images.flatMap((job) => Array.isArray(job.errors) ? job.errors : []),
        ...videos.flatMap((job) => Array.isArray(job.errors) ? job.errors : []),
      ].slice(0, 50),
      created_at: question.created_at || null,
      updated_at: [
        question.updated_at,
        ...images.map((job) => job.updated_at),
        ...videos.map((job) => job.updated_at),
        ...queue.map((job) => job.updated_at),
      ].filter(Boolean).sort().at(-1) || null,
    };
  }).sort((left, right) => String(right.updated_at || right.created_at || "")
    .localeCompare(String(left.updated_at || left.created_at || "")));
  const counts = {};
  for (const pipeline of pipelines) counts[pipeline.status] = Number(counts[pipeline.status] || 0) + 1;
  return {
    build: MULTI_QBANK_INGESTION_BUILD,
    generated_at: new Date().toISOString(),
    summary: {
      total_qbanks: pipelines.length,
      counts,
      active_qbanks: pipelines.filter((row) => ["running", "queued", "retry_wait"].includes(row.status)).length,
      failed_qbanks: pipelines.filter((row) => row.status === "failed").length,
      orphan_background_jobs: orphanBackgroundJobs.length,
    },
    control_plane: clone(controlPlane || {}),
    qbanks: pipelines,
    orphan_background_jobs: orphanBackgroundJobs,
  };
}
