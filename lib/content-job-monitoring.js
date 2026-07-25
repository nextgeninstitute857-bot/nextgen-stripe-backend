const ACTIVE_HEARTBEAT_STATUSES = new Set(["running", "pause_requested", "cancel_requested"]);
const WAITING_STATUSES = new Set(["queued", "retry_wait"]);
const TERMINAL_SUCCESS_STATUSES = new Set(["completed"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled"]);

const STAGE_LABELS = {
  recovering_media_zip_directory: "Preparing the cached media ZIP directory",
  validating_media_resume: "Validating saved media from the local ZIP cache",
  indexing_media_zip: "Indexing referenced media",
  uploading_private_images: "Uploading images and audio to private R2",
  matching_private_media: "Matching media to questions",
  saving_private_media: "Saving private draft links",
  image_import_complete: "Images and audio complete",
  extracting_private_videos: "Indexing referenced videos",
  uploading_private_videos: "Uploading and linking private Vimeo videos",
  video_import_complete: "Video import complete",
  extracting_zip: "Opening ZIP",
  previewing_questions: "Building question preview",
  importing_questions: "Importing private draft questions",
  draft_import_complete: "Question import complete",
};

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedInteger(value, fallback = 0) {
  const parsed = finiteNumber(value, fallback);
  return Math.max(0, Math.floor(parsed));
}

function cleanText(value, maximum = 240) {
  return String(value || "").trim().slice(0, maximum);
}

function jobErrorCategory(value) {
  const message = String(value || "");
  if (!message) return null;
  if (/\b53100\b|could not extend (?:file|relation).*(?:no space|disk full)|postgres(?:ql)?.*(?:disk|storage).*(?:full|exhausted)/i.test(message)) {
    return "postgres_storage";
  }
  if (/\bENOSPC\b|no space left on device|disk quota exceeded/i.test(message)) return "host_storage";
  if (/vimeo|tus upload|upload stopped transferring bytes/i.test(message)) return "vimeo_transfer";
  if (/\bR2\b|cloudflare|s3|socket hang up|request timed out|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return "object_storage_transfer";
  }
  if (/recovered after process interruption|process interruption|worker.*(?:exit|restart|interrupted)/i.test(message)) {
    return "process_interruption";
  }
  return "backend";
}

function latestJob(jobs = []) {
  return [...(Array.isArray(jobs) ? jobs : [])]
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || 0) || 0;
      const rightTime = Date.parse(right.updated_at || right.created_at || 0) || 0;
      return rightTime - leftTime;
    })[0] || null;
}

export function contentJobMonitoring(jobs = [], {
  nowMs = Date.now(),
  staleMs = 3 * 60 * 1000,
} = {}) {
  const job = latestJob(jobs);
  const safeStaleMs = Math.max(30_000, finiteNumber(staleMs, 3 * 60 * 1000));
  if (!job) {
    return {
      available: false,
      movement: "unknown",
      stalled: false,
      percent: null,
      files_processed: 0,
      files_total: 0,
    };
  }

  const progress = job.progress && typeof job.progress === "object" ? job.progress : {};
  const processed = boundedInteger(
    progress.files_processed
      ?? progress.videos_processed
      ?? progress.questions_processed
      ?? progress.processed,
    0,
  );
  const total = boundedInteger(
    progress.files_total
      ?? progress.videos_total
      ?? progress.questions_total
      ?? progress.total,
    0,
  );
  const explicitPercent = finiteNumber(progress.percent, null);
  const calculatedPercent = total > 0 ? Math.round((processed / total) * 100) : null;
  const completed = TERMINAL_SUCCESS_STATUSES.has(String(job.status || "")) || progress.completed === true;
  const percent = completed
    ? 100
    : explicitPercent == null && calculatedPercent == null
      ? null
      : Math.max(0, Math.min(99, Math.round(explicitPercent ?? calculatedPercent)));

  const heartbeatAt = job.heartbeat_at || job.updated_at || job.started_at || null;
  const heartbeatMs = heartbeatAt ? Date.parse(heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  const movementAt = progress.movement_at || heartbeatAt;
  const movementMs = movementAt ? Date.parse(movementAt) : Number.NaN;
  const movementAgeMs = Number.isFinite(movementMs) ? Math.max(0, nowMs - movementMs) : null;
  const active = ACTIVE_HEARTBEAT_STATUSES.has(String(job.status || ""));
  const workerUnresponsive = Boolean(active && heartbeatAgeMs != null && heartbeatAgeMs > safeStaleMs);
  const stalled = Boolean(active && movementAgeMs != null && movementAgeMs > safeStaleMs);

  let movement = "unknown";
  if (stalled) movement = "stalled";
  else if (active) movement = "moving";
  else if (WAITING_STATUSES.has(String(job.status || ""))) movement = "waiting";
  else if (String(job.status || "") === "paused") movement = "paused";
  else if (TERMINAL_SUCCESS_STATUSES.has(String(job.status || ""))) movement = "complete";
  else if (TERMINAL_FAILURE_STATUSES.has(String(job.status || ""))) movement = "failed";

  const stage = cleanText(progress.stage || job.status, 100);
  const error = cleanText(job.error, 1000) || null;
  return {
    available: true,
    background_job_id: job.id,
    status: cleanText(job.status, 60),
    movement,
    stage,
    stage_label: STAGE_LABELS[stage] || stage.replace(/_/g, " "),
    percent,
    files_processed: processed,
    files_total: total,
    bytes_processed: boundedInteger(progress.bytes_processed, 0),
    durable_bytes_processed: boundedInteger(progress.durable_bytes_processed, 0),
    bytes_total: boundedInteger(progress.bytes_total, 0),
    current_file: cleanText(progress.current_file, 300) || null,
    current_file_bytes: boundedInteger(progress.current_file_bytes, 0),
    current_file_total_bytes: boundedInteger(progress.current_file_total_bytes, 0),
    resumed_files: boundedInteger(progress.resumed_files, 0),
    newly_uploaded: boundedInteger(progress.newly_uploaded, 0),
    workers_configured: boundedInteger(progress.workers_configured, 0),
    workers_active: boundedInteger(progress.workers_active, 0),
    checkpoint_batch_size: boundedInteger(progress.checkpoint_batch_size, 0),
    checkpoint_pending: boundedInteger(progress.checkpoint_pending, 0),
    recovery_entries_scanned: boundedInteger(progress.recovery_entries_scanned, 0),
    recovery_entries_total: boundedInteger(progress.recovery_entries_total, 0),
    resumed_files_validated: boundedInteger(progress.resumed_files_validated, 0),
    directory_cache: cleanText(progress.directory_cache, 80) || null,
    directory_cache_bytes: boundedInteger(progress.directory_cache_bytes, 0),
    directory_cache_persistent: progress.directory_cache_persistent === true,
    recovery_phase: cleanText(progress.recovery_phase, 100) || null,
    entry_open_timeout_ms: boundedInteger(progress.entry_open_timeout_ms, 0),
    finalization_assets_committed: boundedInteger(progress.finalization_assets_committed, 0),
    finalization_assets_total: boundedInteger(progress.finalization_assets_total, 0),
    finalization_links_verified: boundedInteger(progress.finalization_links_verified, 0),
    finalization_links_created: boundedInteger(progress.finalization_links_created, 0),
    finalization_link_conflicts: boundedInteger(progress.finalization_link_conflicts, 0),
    finalization_batches_committed: boundedInteger(progress.finalization_batches_committed, 0),
    finalization_batches_total: boundedInteger(progress.finalization_batches_total, 0),
    finalization_batch_size: boundedInteger(progress.finalization_batch_size, 0),
    finalization_cache: cleanText(progress.finalization_cache, 80) || null,
    finalization_complete: progress.finalization_complete === true,
    files_per_minute: Math.max(0, finiteNumber(progress.files_per_minute, 0)),
    eta_seconds: finiteNumber(progress.eta_seconds, null) == null
      ? null
      : boundedInteger(progress.eta_seconds, 0),
    inventory_cache: cleanText(progress.inventory_cache, 80) || null,
    accelerated: progress.accelerated === true,
    reused: boundedInteger(progress.reused, 0),
    failures: boundedInteger(progress.failures, 0),
    heartbeat_at: heartbeatAt,
    heartbeat_age_seconds: heartbeatAgeMs == null ? null : Math.floor(heartbeatAgeMs / 1000),
    movement_at: movementAt,
    movement_age_seconds: movementAgeMs == null ? null : Math.floor(movementAgeMs / 1000),
    stale_after_seconds: Math.floor(safeStaleMs / 1000),
    stalled,
    worker_unresponsive: workerUnresponsive,
    attempts: boundedInteger(job.attempts, 0),
    interrupted_count: boundedInteger(job.interrupted_count, 0),
    error,
    error_category: jobErrorCategory(error),
  };
}
