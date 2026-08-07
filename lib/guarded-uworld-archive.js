import crypto from "node:crypto";

const ARCHIVE_NAME = "Uworld 1.zip";
const MIN_ARCHIVE_BYTES = 8 * 1024 ** 3;
const MAX_ARCHIVE_BYTES = 10 * 1024 ** 3;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ALLOWED_PURPOSES = new Set(["question_zip", "image_zip", "media_zip"]);

function text(value) { return String(value || "").trim(); }
function filenameExact(value) { return /^uworld 1\.zip$/i.test(text(value)); }
function positiveBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function guardedUworldArchiveFingerprint({ objectKey, sizeBytes, etag }) {
  return crypto.createHash("sha256")
    .update(`${text(objectKey)}:${Number(sizeBytes || 0)}:${text(etag)}`)
    .digest("hex");
}

function appendCandidate(map, input = {}) {
  const objectKey = text(input.object_key || input.objectKey);
  if (!objectKey || !filenameExact(input.original_filename || input.originalFilename)) return;
  const existing = map.get(objectKey) || {
    object_key: objectKey,
    original_filename: ARCHIVE_NAME,
    upload_ids: new Set(),
    purposes: new Set(),
    declared_sizes: new Set(),
    manifest_fingerprints: new Set(),
    upload_statuses: new Set(),
    job_ids: new Set(),
    job_statuses: new Set(),
    active_leases: 0,
    sources: new Set(),
  };
  if (text(input.upload_id || input.uploadId || input.id)) {
    existing.upload_ids.add(text(input.upload_id || input.uploadId || input.id));
  }
  if (text(input.purpose)) existing.purposes.add(text(input.purpose));
  if (positiveBytes(input.total_bytes || input.totalBytes || input.size_bytes || input.sizeBytes)) {
    existing.declared_sizes.add(positiveBytes(input.total_bytes || input.totalBytes || input.size_bytes || input.sizeBytes));
  }
  if (text(input.fingerprint)) existing.manifest_fingerprints.add(text(input.fingerprint));
  if (text(input.upload_status || input.uploadStatus)) {
    existing.upload_statuses.add(text(input.upload_status || input.uploadStatus));
  }
  if (text(input.job_id || input.jobId)) existing.job_ids.add(text(input.job_id || input.jobId));
  if (text(input.job_status || input.jobStatus)) existing.job_statuses.add(text(input.job_status || input.jobStatus));
  existing.active_leases = Math.max(existing.active_leases, Number(input.active_leases || input.activeLeases || 0));
  if (text(input.source)) existing.sources.add(text(input.source));
  map.set(objectKey, existing);
}

function publicCandidate(candidate) {
  return {
    object_key: candidate.object_key,
    original_filename: candidate.original_filename,
    upload_ids: [...candidate.upload_ids].sort(),
    purposes: [...candidate.purposes].sort(),
    declared_sizes: [...candidate.declared_sizes].sort((a, b) => a - b),
    manifest_fingerprints: [...candidate.manifest_fingerprints].sort(),
    upload_statuses: [...candidate.upload_statuses].sort(),
    job_ids: [...candidate.job_ids].sort(),
    job_statuses: [...candidate.job_statuses].sort(),
    active_leases: candidate.active_leases,
    sources: [...candidate.sources].sort(),
  };
}

export async function inspectGuardedUworldArchives({
  uploads = [],
  jobs = [],
  expectedFingerprints = [],
  fallbackFilenames = {},
  headObject,
} = {}) {
  if (typeof headObject !== "function") throw new TypeError("headObject is required");
  const candidatesByKey = new Map();
  for (const upload of uploads) {
    appendCandidate(candidatesByKey, {
      ...upload,
      upload_id: upload.id,
      upload_status: upload.status,
      source: "upload_manifest",
    });
  }
  for (const job of jobs) {
    const payload = job?.payload || {};
    const source = payload.source || {};
    if (text(source.type).toLowerCase() !== "r2") continue;
    appendCandidate(candidatesByKey, {
      object_key: source.objectKey || source.object_key,
      size_bytes: source.sizeBytes || source.size_bytes,
      original_filename:
        job?.metadata?.original_filename
        || payload?.metadata?.original_filename
        || fallbackFilenames[text(job?.metadata?.domain_job_id)]
        || ARCHIVE_NAME,
      upload_id: payload.upload_id,
      purpose: job?.metadata?.purpose,
      fingerprint: payload.sha256,
      job_id: job?.id,
      job_status: job?.status,
      source: "exact_job_lineage",
    });
  }

  const expected = new Set(expectedFingerprints.map(text).filter(Boolean));
  const allJobsInactive = jobs.every((job) => TERMINAL_JOB_STATUSES.has(text(job?.status)));
  const inspected = await Promise.all([...candidatesByKey.values()].map(async (raw) => {
    const candidate = publicCandidate(raw);
    let head = null;
    let head_error = null;
    try { head = await headObject(candidate.object_key); }
    catch (error) { head_error = text(error?.message || error); }
    const actualBytes = positiveBytes(head?.sizeBytes || head?.size_bytes);
    const actualEtag = text(head?.etag);
    const actualFingerprint = head
      ? guardedUworldArchiveFingerprint({ objectKey: candidate.object_key, sizeBytes: actualBytes, etag: actualEtag })
      : "";
    const declaredSizeExact = candidate.declared_sizes.length === 0
      || candidate.declared_sizes.every((size) => size === actualBytes);
    const purposeExact = candidate.sources.includes("exact_job_lineage")
      || candidate.purposes.some((purpose) => ALLOWED_PURPOSES.has(purpose));
    const finalizedSource = candidate.sources.includes("exact_job_lineage")
      || (candidate.upload_statuses.length > 0
        && candidate.upload_statuses.every((status) => status === "finalized"));
    const checks = {
      filename_exact: filenameExact(candidate.original_filename),
      exact_job_identity: expected.has(actualFingerprint),
      r2_head_verified: Boolean(head && actualBytes > 0 && actualEtag),
      archive_size_exact: actualBytes >= MIN_ARCHIVE_BYTES && actualBytes <= MAX_ARCHIVE_BYTES,
      declared_size_exact: declaredSizeExact,
      purpose_exact: purposeExact,
      finalized_source: finalizedSource,
      no_active_leases: candidate.active_leases === 0,
      no_active_jobs: allJobsInactive,
    };
    return {
      ...candidate,
      total_bytes: actualBytes,
      etag: actualEtag,
      fingerprint: actualFingerprint,
      head_error,
      checks,
      exact: Object.values(checks).every(Boolean),
    };
  }));
  const exact = inspected.filter((candidate) => candidate.exact);
  return {
    candidates: inspected,
    exact,
    archive: exact.length === 1 ? exact[0] : null,
    ready: exact.length === 1,
  };
}
