import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ACTIVE_STATUSES = new Set(["queued", "running", "retry_wait", "paused", "pause_requested", "cancel_requested"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function cleanPositiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function errorMessage(error) {
  return String(error?.message || error || "Background job failed").slice(0, 2000);
}

function publicJob(job, includePayload = false) {
  if (!job) return null;
  const output = {
    id: job.id,
    type: job.type,
    lane: job.lane,
    status: job.status,
    priority: job.priority,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    progress: clone(job.progress || {}),
    checkpoint: clone(job.checkpoint || {}),
    metadata: clone(job.metadata || {}),
    error: job.error || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    queued_at: job.queued_at || null,
    started_at: job.started_at || null,
    heartbeat_at: job.heartbeat_at || null,
    finished_at: job.finished_at || null,
    next_retry_at: job.next_retry_at || null,
    interrupted_count: Number(job.interrupted_count || 0),
  };
  if (includePayload) output.payload = clone(job.payload || {});
  return output;
}

export class SafeJobControlError extends Error {
  constructor(action) {
    super(action === "cancel" ? "Background job cancellation requested" : "Background job pause requested");
    this.name = "SafeJobControlError";
    this.action = action === "cancel" ? "cancel" : "pause";
  }
}

export class SafeJobLeaseError extends Error {
  constructor(jobId) {
    super(`Background job lease was lost: ${jobId}`);
    this.name = "SafeJobLeaseError";
    this.statusCode = 409;
  }
}

/**
 * Small persistent scheduler for heavy disk/network work.
 *
 * Job metadata/checkpoints are written to the disk recovery manifest and, when
 * configured, an authoritative external store such as PostgreSQL. Upload bytes
 * remain in dedicated files and callers decide when those files are removed.
 */
export class SafeBackgroundQueue {
  constructor({
    directory,
    maxConcurrency = 1,
    laneConcurrency = {},
    retryBaseMs = 5_000,
    memoryRetryMs = 15_000,
    memoryGate = () => false,
    logger = console,
    now = () => new Date(),
    persistentStore = null,
    leaseRetryMs = 15_000,
    maxRetainedTerminalJobs = 500,
    maxManifestReadBytes = 32 * 1024 * 1024,
  } = {}) {
    if (!directory) throw new Error("SafeBackgroundQueue directory is required");
    this.directory = path.resolve(directory);
    this.manifestFile = path.join(this.directory, "jobs.json");
    this.maxConcurrency = cleanPositiveInteger(maxConcurrency, 1, 1, 16);
    this.laneConcurrency = Object.fromEntries(Object.entries(laneConcurrency || {}).map(([lane, limit]) => [String(lane), cleanPositiveInteger(limit, 1, 1, 16)]));
    this.retryBaseMs = cleanPositiveInteger(retryBaseMs, 5_000, 10, 60 * 60 * 1000);
    this.memoryRetryMs = cleanPositiveInteger(memoryRetryMs, 15_000, 100, 60 * 60 * 1000);
    this.memoryGate = typeof memoryGate === "function" ? memoryGate : () => false;
    this.logger = logger || console;
    this.now = now;
    this.persistentStore = persistentStore && typeof persistentStore === "object"
      ? persistentStore
      : null;
    this.leaseRetryMs = cleanPositiveInteger(leaseRetryMs, 15_000, 1_000, 10 * 60 * 1000);
    this.maxRetainedTerminalJobs = cleanPositiveInteger(
      maxRetainedTerminalJobs,
      500,
      10,
      5_000,
    );
    this.maxManifestReadBytes = cleanPositiveInteger(
      maxManifestReadBytes,
      32 * 1024 * 1024,
      1024 * 1024,
      256 * 1024 * 1024,
    );
    this.handlers = new Map();
    this.jobs = new Map();
    this.active = new Set();
    this.initialized = false;
    this.initializing = null;
    this.writeChain = Promise.resolve();
    this.kickScheduled = false;
    this.wakeTimer = null;
    this.wakeAt = 0;
    this.memoryPauses = 0;
    this.lastMemoryPauseAt = null;
    this.recoverySource = "not_initialized";
    this.diskManifestSkipped = null;
    this.prunedTerminalJobs = 0;
  }

  register(type, handler, options = {}) {
    const cleanType = String(type || "").trim();
    if (!cleanType || typeof handler !== "function") throw new Error("Background job type and handler are required");
    this.handlers.set(cleanType, { handler, ...options });
    if (this.initialized) this.kick();
    return this;
  }

  async readDiskRecoveryManifest() {
    try {
      const stat = await fs.stat(this.manifestFile);
      if (stat.size > this.maxManifestReadBytes) {
        this.diskManifestSkipped = {
          reason: "oversized_recovery_manifest",
          size_bytes: stat.size,
          maximum_bytes: this.maxManifestReadBytes,
        };
        this.logger.warn?.(
          `Background job disk recovery manifest was skipped because it is ${stat.size} bytes; `
          + `the safe read limit is ${this.maxManifestReadBytes} bytes`,
        );
        return { version: 1, jobs: [] };
      }
      return JSON.parse(await fs.readFile(this.manifestFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, jobs: [] };
      const corrupt = `${this.manifestFile}.corrupt-${Date.now()}`;
      await fs.rename(this.manifestFile, corrupt).catch(() => {});
      this.logger.warn?.("Background job manifest was unreadable and was quarantined", error.message);
      return { version: 1, jobs: [] };
    }
  }

  pruneRetainedTerminalJobs() {
    const terminalJobs = [...this.jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => String(
        right.updated_at || right.finished_at || right.created_at || "",
      ).localeCompare(String(
        left.updated_at || left.finished_at || left.created_at || "",
      )));
    const removable = terminalJobs.slice(this.maxRetainedTerminalJobs);
    for (const job of removable) this.jobs.delete(String(job.id));
    this.prunedTerminalJobs += removable.length;
    return removable.length;
  }

  async initialize() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      let parsed = { version: 1, jobs: [] };
      let storedRows = null;
      if (this.persistentStore?.load) {
        try {
          storedRows = await this.persistentStore.load();
          this.recoverySource = this.persistentStore.kind || "external";
        } catch (error) {
          this.logger.warn?.(
            "Authoritative background job store was unavailable; using bounded disk recovery",
            error.message,
          );
        }
      }
      if (!Array.isArray(storedRows)) {
        parsed = await this.readDiskRecoveryManifest();
        this.recoverySource = "disk";
      }
      const recoveredRows = new Map();
      for (const row of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
        if (row?.id && row?.type) recoveredRows.set(String(row.id), row);
      }
      for (const row of Array.isArray(storedRows) ? storedRows : []) {
        if (row?.id && row?.type) recoveredRows.set(String(row.id), row);
      }
      for (const row of recoveredRows.values()) {
        this.jobs.set(String(row.id), row);
      }
      const nowIso = this.now().toISOString();
      let changed = false;
      const changedJobs = [];
      const recoveredTerminals = [];
      for (const job of this.jobs.values()) {
        if (!["running", "pause_requested", "cancel_requested"].includes(job.status)) continue;
        const registration = this.handlers.get(job.type);
        const recoverable = registration?.canRecover ? await registration.canRecover(clone(job)).catch(() => false) : Boolean(registration);
        if (!recoverable) {
          job.status = "failed";
          job.error = registration ? "Interrupted job input is no longer available" : "No handler is registered for the interrupted job";
          job.finished_at = nowIso;
        } else if (job.status === "cancel_requested") {
          job.status = "cancelled";
          job.finished_at = nowIso;
        } else if (job.status === "pause_requested") {
          job.status = "paused";
        } else {
          job.status = "queued";
          job.queued_at = nowIso;
          job.interrupted_count = Number(job.interrupted_count || 0) + 1;
          job.error = "Recovered after process interruption";
        }
        job.updated_at = nowIso;
        if (TERMINAL_STATUSES.has(job.status)) recoveredTerminals.push(job);
        changedJobs.push(job);
        changed = true;
      }
      const pruned = this.pruneRetainedTerminalJobs();
      if (pruned) changed = true;
      this.initialized = true;
      if (
        changed
        || !Array.isArray(parsed.jobs)
        || Array.isArray(storedRows)
        || this.diskManifestSkipped
      ) await this.persist(
        changedJobs,
      );
      for (const job of recoveredTerminals) await this.callTerminal(job);
      this.kick();
      return this;
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async persist(changedJobs = null) {
    this.pruneRetainedTerminalJobs();
    const snapshot = {
      version: 1,
      updated_at: this.now().toISOString(),
      jobs: [...this.jobs.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    };
    const changed = changedJobs == null
      ? snapshot.jobs
      : (Array.isArray(changedJobs) ? changedJobs : [changedJobs]).filter(Boolean);
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `jobs.${process.pid}.${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(temporary, this.manifestFile);
      if (this.persistentStore?.save) {
        for (const job of changed) await this.persistentStore.save(clone(job));
      }
    });
    return this.writeChain;
  }

  async enqueue({ id, type, lane = "default", payload = {}, metadata = {}, idempotencyKey = "", maxAttempts = 3, priority = 0 } = {}) {
    await this.initialize();
    const cleanType = String(type || "").trim();
    if (!this.handlers.has(cleanType)) throw new Error(`No handler is registered for background job type ${cleanType || "(empty)"}`);
    const cleanKey = String(idempotencyKey || "").trim();
    if (cleanKey) {
      const existing = [...this.jobs.values()].find((job) => job.idempotency_key === cleanKey && ACTIVE_STATUSES.has(job.status));
      if (existing) return { job: publicJob(existing), deduplicated: true };
    }
    const nowIso = this.now().toISOString();
    const job = {
      id: String(id || crypto.randomUUID()),
      type: cleanType,
      lane: String(lane || "default"),
      status: "queued",
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      attempts: 0,
      max_attempts: cleanPositiveInteger(maxAttempts, 3, 1, 20),
      idempotency_key: cleanKey,
      payload: clone(payload || {}),
      metadata: clone(metadata || {}),
      progress: {},
      checkpoint: {},
      error: null,
      interrupted_count: 0,
      created_at: nowIso,
      updated_at: nowIso,
      queued_at: nowIso,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      next_retry_at: null,
    };
    if (this.jobs.has(job.id)) throw new Error(`Background job ${job.id} already exists`);
    this.jobs.set(job.id, job);
    try { await this.persist(job); }
    catch (error) { this.jobs.delete(job.id); throw error; }
    this.kick();
    return { job: publicJob(job), deduplicated: false };
  }

  get(id, { includePayload = false } = {}) {
    return publicJob(this.jobs.get(String(id)), includePayload);
  }

  list({ status = "", type = "", lane = "", limit = 100, includePayload = false } = {}) {
    const safeLimit = cleanPositiveInteger(limit, 100, 1, 500);
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .filter((job) => !type || job.type === type)
      .filter((job) => !lane || job.lane === lane)
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, safeLimit)
      .map((job) => publicJob(job, includePayload));
  }

  summary() {
    const counts = {};
    const lanes = {};
    let oldestQueuedAt = null;
    for (const job of this.jobs.values()) {
      counts[job.status] = Number(counts[job.status] || 0) + 1;
      lanes[job.lane] ||= { total: 0, queued: 0, running: 0, failed: 0 };
      lanes[job.lane].total += 1;
      if (job.status in lanes[job.lane]) lanes[job.lane][job.status] += 1;
      if (job.status === "queued" && (!oldestQueuedAt || job.queued_at < oldestQueuedAt)) oldestQueuedAt = job.queued_at;
    }
    return {
      initialized: this.initialized,
      max_concurrency: this.maxConcurrency,
      lane_concurrency: { ...this.laneConcurrency },
      active: this.active.size,
      persistence: this.persistentStore
        ? {
            authoritative: this.persistentStore.kind || "external",
            disk_recovery_copy: true,
            execution_leases: typeof this.persistentStore.acquireLease === "function",
          }
        : {
            authoritative: "disk",
            disk_recovery_copy: true,
            execution_leases: false,
          },
      counts,
      lanes,
      oldest_queued_at: oldestQueuedAt,
      memory_pauses: this.memoryPauses,
      last_memory_pause_at: this.lastMemoryPauseAt,
      retained_jobs: this.jobs.size,
      retained_terminal_jobs: [...this.jobs.values()]
        .filter((job) => TERMINAL_STATUSES.has(job.status)).length,
      max_retained_terminal_jobs: this.maxRetainedTerminalJobs,
      pruned_terminal_jobs: this.prunedTerminalJobs,
      recovery_source: this.recoverySource,
      disk_manifest_read_limit_bytes: this.maxManifestReadBytes,
      disk_manifest_skipped: this.diskManifestSkipped,
    };
  }

  activeJobIds() {
    return [...this.jobs.values()].filter((job) => ACTIVE_STATUSES.has(job.status)).map((job) => job.id);
  }

  async updateCheckpoint(id, checkpoint = {}, progress = undefined) {
    const job = this.jobs.get(String(id));
    if (!job) throw new Error("Background job not found");
    await this.renewLease(job);
    job.checkpoint = clone(checkpoint || {});
    if (progress !== undefined) job.progress = clone(progress || {});
    job.heartbeat_at = this.now().toISOString();
    job.updated_at = job.heartbeat_at;
    await this.persist(job);
    this.throwIfControlRequested(job);
    return publicJob(job);
  }

  async heartbeat(id, progress = undefined) {
    const job = this.jobs.get(String(id));
    if (!job) throw new Error("Background job not found");
    await this.renewLease(job);
    if (progress !== undefined) job.progress = clone(progress || {});
    job.heartbeat_at = this.now().toISOString();
    job.updated_at = job.heartbeat_at;
    await this.persist(job);
    this.throwIfControlRequested(job);
    return publicJob(job);
  }

  throwIfControlRequested(job) {
    if (job.status === "cancel_requested") throw new SafeJobControlError("cancel");
    if (job.status === "pause_requested") throw new SafeJobControlError("pause");
  }

  async renewLease(job) {
    if (!this.active.has(job.id) || typeof this.persistentStore?.renewLease !== "function") return true;
    const renewed = await this.persistentStore.renewLease(job.id);
    if (!renewed) throw new SafeJobLeaseError(job.id);
    return true;
  }

  async pause(id) {
    await this.initialize();
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (job.status === "running") job.status = "pause_requested";
    else if (["queued", "retry_wait"].includes(job.status)) job.status = "paused";
    else if (job.status !== "paused") throw Object.assign(new Error(`Job cannot be paused from status ${job.status}`), { statusCode: 409 });
    job.updated_at = this.now().toISOString();
    await this.persist(job);
    return publicJob(job);
  }

  async resume(id) {
    await this.initialize();
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (job.status !== "paused") throw Object.assign(new Error(`Job cannot be resumed from status ${job.status}`), { statusCode: 409 });
    job.status = "queued";
    job.error = null;
    job.queued_at = this.now().toISOString();
    job.updated_at = job.queued_at;
    await this.persist(job);
    this.kick();
    return publicJob(job);
  }

  async cancel(id) {
    await this.initialize();
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (job.status === "running" || job.status === "pause_requested") {
      job.status = "cancel_requested";
      job.updated_at = this.now().toISOString();
      await this.persist(job);
      return publicJob(job);
    }
    if (["queued", "retry_wait", "paused", "failed"].includes(job.status)) {
      job.status = "cancelled";
      job.finished_at = this.now().toISOString();
      job.updated_at = job.finished_at;
      await this.persist(job);
      await this.callTerminal(job);
      return publicJob(job);
    }
    if (!TERMINAL_STATUSES.has(job.status)) throw Object.assign(new Error(`Job cannot be cancelled from status ${job.status}`), { statusCode: 409 });
    return publicJob(job);
  }

  async retry(id) {
    await this.initialize();
    const job = this.jobs.get(String(id));
    if (!job) return null;
    if (job.status !== "failed") throw Object.assign(new Error(`Job cannot be retried from status ${job.status}`), { statusCode: 409 });
    const registration = this.handlers.get(job.type);
    if (!registration) throw Object.assign(new Error("No handler is registered for this job"), { statusCode: 409 });
    if (registration.canRecover && !(await registration.canRecover(clone(job)))) {
      throw Object.assign(new Error("The job input is no longer available"), { statusCode: 409 });
    }
    job.status = "queued";
    job.attempts = 0;
    job.error = null;
    job.finished_at = null;
    job.next_retry_at = null;
    job.queued_at = this.now().toISOString();
    job.updated_at = job.queued_at;
    await this.persist(job);
    this.kick();
    return publicJob(job);
  }

  kick() {
    if (!this.initialized || this.kickScheduled) return;
    this.kickScheduled = true;
    queueMicrotask(() => {
      this.kickScheduled = false;
      this.drain().catch((error) => this.logger.error?.("Background queue drain failed", error));
    });
  }

  laneActiveCount(lane) {
    let count = 0;
    for (const id of this.active) if (this.jobs.get(id)?.lane === lane) count += 1;
    return count;
  }

  scheduleWake(delayMs) {
    const requestedAt = Date.now() + Math.max(10, delayMs);
    if (this.wakeTimer && this.wakeAt <= requestedAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = requestedAt;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = 0;
      this.kick();
    }, Math.max(10, requestedAt - Date.now()));
    this.wakeTimer.unref?.();
  }

  nextRunnable(excludedIds = new Set()) {
    const nowMs = this.now().getTime();
    return [...this.jobs.values()]
      .filter((job) => !excludedIds.has(job.id))
      .filter((job) => job.status === "queued" || (job.status === "retry_wait" && Date.parse(job.next_retry_at || 0) <= nowMs))
      .filter((job) => this.handlers.has(job.type))
      .filter((job) => this.laneActiveCount(job.lane) < (this.laneConcurrency[job.lane] || this.maxConcurrency))
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.queued_at).localeCompare(String(b.queued_at)))[0] || null;
  }

  async drain() {
    if (!this.initialized || this.active.size >= this.maxConcurrency) return;
    while (this.active.size < this.maxConcurrency) {
      const memoryBlocked = new Set();
      let job = this.nextRunnable(memoryBlocked);
      while (job && this.memoryGate(publicJob(job))) {
        memoryBlocked.add(job.id);
        job = this.nextRunnable(memoryBlocked);
      }
      if (memoryBlocked.size) {
        this.memoryPauses += 1;
        this.lastMemoryPauseAt = this.now().toISOString();
        this.scheduleWake(this.memoryRetryMs);
      }
      if (!job) break;
      if (typeof this.persistentStore?.acquireLease === "function") {
        const acquired = await this.persistentStore.acquireLease(job.id);
        if (!acquired) {
          this.scheduleWake(this.leaseRetryMs);
          break;
        }
      }
      job.status = "running";
      job.attempts = Number(job.attempts || 0) + 1;
      job.started_at ||= this.now().toISOString();
      job.heartbeat_at = this.now().toISOString();
      job.updated_at = job.heartbeat_at;
      job.next_retry_at = null;
      this.active.add(job.id);
      try {
        await this.persist(job);
      } catch (error) {
        this.active.delete(job.id);
        job.status = "queued";
        job.updated_at = this.now().toISOString();
        await this.persistentStore?.releaseLease?.(job.id).catch(() => {});
        throw error;
      }
      void this.run(job);
    }
    const nextRetry = [...this.jobs.values()]
      .filter((job) => job.status === "retry_wait" && job.next_retry_at)
      .map((job) => Date.parse(job.next_retry_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (nextRetry) this.scheduleWake(Math.max(10, nextRetry - this.now().getTime()));
  }

  async run(job) {
    const registration = this.handlers.get(job.type);
    try {
      await registration.handler({
        job: publicJob(job, true),
        updateCheckpoint: (checkpoint, progress) => this.updateCheckpoint(job.id, checkpoint, progress),
        heartbeat: (progress) => this.heartbeat(job.id, progress),
        throwIfControlRequested: () => this.throwIfControlRequested(job),
      });
      await this.renewLease(job);
      job.status = "completed";
      job.error = null;
      job.progress = { ...(job.progress || {}), completed: true };
      job.finished_at = this.now().toISOString();
      job.updated_at = job.finished_at;
      await this.persist(job);
      await this.callTerminal(job);
    } catch (error) {
      if (error instanceof SafeJobControlError) {
        job.status = error.action === "cancel" ? "cancelled" : "paused";
        job.error = null;
        if (job.status === "cancelled") job.finished_at = this.now().toISOString();
        job.updated_at = this.now().toISOString();
        await this.persist(job);
        if (job.status === "cancelled") await this.callTerminal(job);
      } else if (
        Number(job.attempts || 0) < Number(job.max_attempts || 1)
        && !(
          Number(error?.statusCode || error?.status) >= 400
          && Number(error?.statusCode || error?.status) < 500
          && ![408, 409, 425, 429].includes(Number(error?.statusCode || error?.status))
        )
      ) {
        const delay = Math.min(60 * 60 * 1000, this.retryBaseMs * (2 ** Math.max(0, Number(job.attempts || 1) - 1)));
        job.status = "retry_wait";
        job.error = errorMessage(error);
        job.next_retry_at = new Date(this.now().getTime() + delay).toISOString();
        job.updated_at = this.now().toISOString();
        await this.persist(job);
        this.scheduleWake(delay);
      } else {
        job.status = "failed";
        job.error = errorMessage(error);
        job.finished_at = this.now().toISOString();
        job.updated_at = job.finished_at;
        await this.persist(job);
        await this.callTerminal(job);
      }
    } finally {
      this.active.delete(job.id);
      await this.persistentStore?.releaseLease?.(job.id).catch((error) => {
        this.logger.warn?.(`Background job lease release failed for ${job.id}: ${errorMessage(error)}`);
      });
      this.kick();
    }
  }

  async callTerminal(job) {
    const callback = this.handlers.get(job.type)?.onTerminal;
    if (typeof callback !== "function") return;
    try { await callback(clone(job)); }
    catch (error) { this.logger.warn?.(`Background job terminal cleanup failed for ${job.id}: ${errorMessage(error)}`); }
  }
}
