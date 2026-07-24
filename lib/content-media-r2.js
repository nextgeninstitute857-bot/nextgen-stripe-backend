import crypto from "node:crypto";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { createRequire } from "node:module";
import { Upload } from "@aws-sdk/lib-storage";
import { mediaMatchKeys, slug } from "./content-import-adapter.js";
import { openContentZip, openContentZipEntry } from "./content-zip-source.js";
import {
  contentR2Bucket,
  contentR2Status,
  deleteContentR2Object,
  getContentR2Client,
  signPrivateContentR2Url,
} from "./content-r2-storage.js";
import {
  BoundedTaskPool,
  MediaAssetBatcher,
  mediaAcceleratorConfig,
  mediaRateSnapshot,
} from "./media-ingestion-accelerator.js";
import { contentZipRecoveryConfig } from "./content-zip-directory-cache.js";

const require = createRequire(import.meta.url);
const MIME = require("mime-types");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga"]);
const MAX_IMAGE_BYTES = Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_IMAGE_BYTES || 50 * 1024 ** 2));
const MAX_AUDIO_BYTES = Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_AUDIO_BYTES || 500 * 1024 ** 2));
const MAX_MEDIA_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_ENTRIES || 100000));
const MAX_MEDIA_UNCOMPRESSED_BYTES = Math.max(MAX_AUDIO_BYTES, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_UNCOMPRESSED_BYTES || 25 * 1024 ** 3));
const MEDIA_HEARTBEAT_MS = Math.max(5_000, Math.min(60_000, Number(process.env.NEXTGEN_CONTENT_MEDIA_HEARTBEAT_MS || 15_000)));

export function contentMediaStatus(source = process.env) {
  const zipRecovery = contentZipRecoveryConfig(source);
  return {
    ...contentR2Status(source),
    public_access: false,
    supported_media: ["image", "audio"],
    accelerator: mediaAcceleratorConfig(source),
    zip_recovery: {
      directory_cache_max_bytes: zipRecovery.cache_max_bytes,
      directory_cache_memory_bytes: zipRecovery.cache_memory_max_bytes,
      range_timeout_ms: zipRecovery.range_timeout_ms,
      entry_open_timeout_ms: zipRecovery.entry_open_timeout_ms,
      heartbeat_ms: zipRecovery.heartbeat_ms,
    },
  };
}

export function safeMediaEntryName(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) return null;
  const normalized = raw;
  if (!normalized || normalized.split("/").includes("..") || normalized.endsWith("/")) return null;
  const extension = path.extname(normalized).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension) ? normalized : null;
}

export function contentMediaKind(value) {
  return AUDIO_EXTENSIONS.has(path.extname(String(value || "")).toLowerCase()) ? "audio" : "image";
}

function exactMediaPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").toLowerCase();
}

export function matchMediaReferences(references = [], assets = []) {
  const byKey = new Map();
  const byExact = new Map();
  const byPath = new Map();
  for (const asset of assets) for (const key of mediaMatchKeys(asset.originalName)) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(asset);
  }
  for (const asset of assets) {
    const exact = path.basename(String(asset.originalName || "")).toLowerCase();
    if (!byExact.has(exact)) byExact.set(exact, []);
    byExact.get(exact).push(asset);
    const fullPath = exactMediaPath(asset.originalName);
    if (!byPath.has(fullPath)) byPath.set(fullPath, []);
    byPath.get(fullPath).push(asset);
  }
  const matches = [];
  const missing = [];
  const ambiguous = [];
  const used = new Set();
  for (const reference of references) {
    const candidates = new Map();
    const referencePath = exactMediaPath(reference.mediaRef);
    const pathMatches = referencePath.includes("/") ? (byPath.get(referencePath) || []) : [];
    const exact = pathMatches.length ? pathMatches : (byExact.get(path.basename(String(reference.mediaRef || "")).toLowerCase()) || []);
    if (exact.length) exact.forEach((asset) => candidates.set(asset.sha256, asset));
    else for (const key of mediaMatchKeys(reference.mediaRef)) for (const asset of byKey.get(key) || []) candidates.set(asset.sha256, asset);
    if (candidates.size === 1) {
      const asset = [...candidates.values()][0]; used.add(asset.sha256); matches.push({ ...reference, asset });
    } else if (candidates.size === 0) missing.push(reference);
    else ambiguous.push({ ...reference, candidates: [...candidates.values()].map((asset) => asset.originalName) });
  }
  return { matches, missing, ambiguous, unreferenced: assets.filter((asset) => !used.has(asset.sha256)) };
}

function mediaReferenceKeys(references = []) {
  return new Set(references.flatMap((reference) => mediaMatchKeys(reference.mediaRef)));
}

function mediaEntryCandidate(entry, referenceKeys) {
  const originalName = safeMediaEntryName(entry.fileName);
  if (!originalName || !referenceKeys.size) return null;
  if (!mediaMatchKeys(originalName).some((key) => referenceKeys.has(key))) return null;
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw Object.assign(new Error("Encrypted media ZIP entries are not supported"), { statusCode: 400 });
  }
  const mediaKind = contentMediaKind(originalName);
  const maxAssetBytes = mediaKind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (Number(entry.uncompressedSize || 0) > maxAssetBytes) {
    throw Object.assign(new Error(`${mediaKind} exceeds limit: ${originalName}`), { statusCode: 413 });
  }
  return { originalName, mediaKind, maxAssetBytes };
}

function validateMediaArchiveProgress(entries, uncompressedBytes) {
  if (entries > MAX_MEDIA_ENTRIES) {
    throw Object.assign(new Error("Media ZIP has too many entries"), { statusCode: 413 });
  }
  if (uncompressedBytes > MAX_MEDIA_UNCOMPRESSED_BYTES) {
    throw Object.assign(new Error("Media ZIP expands beyond the configured safety limit"), { statusCode: 413 });
  }
}

export async function inspectMediaZip({
  zipFile,
  zipSource = zipFile,
  references = [],
  directoryCacheKey = "",
  onProgress,
  adapters = {},
}) {
  const openZip = typeof adapters.openZip === "function" ? adapters.openZip : openContentZip;
  const recoveryConfig = contentZipRecoveryConfig();
  const zip = await openZip(zipSource, {
    directoryCacheKey,
    rangeTimeoutMs: recoveryConfig.range_timeout_ms,
    entryOpenTimeoutMs: recoveryConfig.entry_open_timeout_ms,
    onDirectoryCacheProgress: onProgress
      ? (progress) => onProgress({
        stage: "recovering_media_zip_directory",
        files_processed: 0,
        files_total: 0,
        bytes_processed: Number(progress.bytes_loaded || 0),
        bytes_total: Number(progress.bytes_total || 0),
        directory_cache: progress.directory_cache || "preparing",
        directory_cache_bytes: Number(progress.directory_cache_bytes || 0),
        directory_cache_persistent: progress.directory_cache_persistent === true,
        movement: progress.movement === true,
      })
      : undefined,
  });
  const referenceKeys = mediaReferenceKeys(references);
  let entries = 0;
  let uncompressedBytes = 0;
  let candidateEntries = 0;
  let candidateUncompressedBytes = 0;
  let lastReportAt = Date.now();
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        uncompressedBytes += Number(entry.uncompressedSize || 0);
        validateMediaArchiveProgress(entries, uncompressedBytes);
        const candidate = mediaEntryCandidate(entry, referenceKeys);
        if (candidate) {
          candidateEntries += 1;
          candidateUncompressedBytes += Number(entry.uncompressedSize || 0);
        }
        const now = Date.now();
        if (onProgress && (entries % 500 === 0 || now - lastReportAt >= MEDIA_HEARTBEAT_MS)) {
          lastReportAt = now;
          await onProgress({
            stage: "indexing_media_zip",
            entries_scanned: entries,
            entries_total: Number(zip.entryCount || 0),
            files_processed: entries,
            files_total: Number(zip.entryCount || 0),
            referenced_files_found: candidateEntries,
            percent: Number(zip.entryCount || 0) > 0
              ? Math.min(99, Math.round((entries / Number(zip.entryCount)) * 100))
              : null,
          });
        }
        zip.readEntry();
      } catch (error) {
        zip.close();
        reject(error);
      }
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return {
    entries,
    uncompressedBytes,
    candidateEntries,
    candidateUncompressedBytes,
  };
}

function safeObjectFilename(originalName) {
  const basename = path.basename(String(originalName || "media.bin"));
  const cleaned = basename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "media.bin").slice(-180);
}

function deterministicMediaObjectKey({
  mediaKind,
  examTrack,
  sourceNamespace,
  importJobId,
  mediaImportJobId,
  entryIndex,
  originalName,
}) {
  const nameFingerprint = crypto.createHash("sha256").update(String(originalName || "")).digest("hex").slice(0, 16);
  return [
    "content",
    mediaKind,
    slug(examTrack),
    slug(sourceNamespace),
    String(importJobId),
    String(mediaImportJobId || importJobId),
    `${entryIndex}-${nameFingerprint}-${safeObjectFilename(originalName)}`,
  ].join("/");
}

async function waitForMediaUpload(upload, {
  onProgress,
  progressSnapshot,
  heartbeatMs = MEDIA_HEARTBEAT_MS,
} = {}) {
  const outcome = upload.done().then(
    (value) => ({ complete: true, value }),
    (error) => ({ complete: true, error }),
  );
  while (true) {
    let heartbeatTimer;
    const result = await Promise.race([
      outcome,
      new Promise((resolve) => {
        heartbeatTimer = setTimeout(() => resolve({ complete: false }), heartbeatMs);
      }),
    ]);
    clearTimeout(heartbeatTimer);
    if (result.complete) {
      if (result.error) throw result.error;
      return result.value;
    }
    try {
      await onProgress?.(progressSnapshot?.() || {});
    } catch (error) {
      await Promise.resolve(upload.abort()).catch(() => {});
      throw error;
    }
  }
}

export async function uploadMediaZipToR2({
  zipFile,
  zipSource = zipFile,
  references = [],
  examTrack,
  sourceNamespace,
  importJobId,
  mediaImportJobId = importJobId,
  inventory = null,
  existingAssets = [],
  directoryCacheKey = "",
  onAsset,
  onAssets,
  onProgress,
  concurrency,
  checkpointBatchSize,
  checkpointIntervalMs,
  progressIntervalMs,
  recoveryHeartbeatMs,
  adapters = {},
}) {
  const accelerator = mediaAcceleratorConfig({
    NEXTGEN_CONTENT_MEDIA_CONCURRENCY: concurrency ?? process.env.NEXTGEN_CONTENT_MEDIA_CONCURRENCY,
    NEXTGEN_CONTENT_MEDIA_CHECKPOINT_BATCH_SIZE: checkpointBatchSize ?? process.env.NEXTGEN_CONTENT_MEDIA_CHECKPOINT_BATCH_SIZE,
    NEXTGEN_CONTENT_MEDIA_CHECKPOINT_INTERVAL_MS: checkpointIntervalMs ?? process.env.NEXTGEN_CONTENT_MEDIA_CHECKPOINT_INTERVAL_MS,
    NEXTGEN_CONTENT_MEDIA_PROGRESS_INTERVAL_MS: progressIntervalMs ?? process.env.NEXTGEN_CONTENT_MEDIA_PROGRESS_INTERVAL_MS,
  });
  const workerConcurrency = accelerator.concurrency;
  const assetBatchSize = accelerator.checkpoint_batch_size;
  const assetCheckpointMs = accelerator.checkpoint_interval_ms;
  const heartbeatMs = accelerator.progress_interval_ms;
  const recoveryConfig = contentZipRecoveryConfig();
  const recoveryHeartbeatIntervalMs = Math.max(
    1_000,
    Number(recoveryHeartbeatMs || recoveryConfig.heartbeat_ms),
  );
  const openZip = typeof adapters.openZip === "function" ? adapters.openZip : openContentZip;
  const openEntry = typeof adapters.openEntry === "function" ? adapters.openEntry : openContentZipEntry;
  const expectedResumedFiles = Array.isArray(existingAssets) ? existingAssets.length : 0;
  const expectedResumedBytes = (Array.isArray(existingAssets) ? existingAssets : [])
    .reduce((total, asset) => total + Math.max(0, Number(asset.sizeBytes || 0)), 0);
  const expectedFilesTotal = Number(inventory?.candidateEntries || 0);
  const expectedBytesTotal = Number(inventory?.candidateUncompressedBytes || 0);
  const zip = await openZip(zipSource, {
    autoClose: false,
    directoryCacheKey,
    rangeTimeoutMs: recoveryConfig.range_timeout_ms,
    entryOpenTimeoutMs: recoveryConfig.entry_open_timeout_ms,
    onDirectoryCacheProgress: onProgress
      ? (progress) => onProgress({
        stage: "recovering_media_zip_directory",
        files_processed: expectedResumedFiles,
        files_total: expectedFilesTotal,
        bytes_processed: expectedResumedBytes,
        durable_bytes_processed: expectedResumedBytes,
        bytes_total: expectedBytesTotal,
        resumed_files: expectedResumedFiles,
        newly_uploaded: 0,
        workers_configured: workerConcurrency,
        workers_active: 0,
        directory_cache: progress.directory_cache || "preparing",
        directory_cache_bytes: Number(progress.directory_cache_bytes || 0),
        directory_cache_persistent: progress.directory_cache_persistent === true,
        recovery_phase: progress.phase || "preparing",
        movement: progress.movement === true,
      })
      : undefined,
  });
  const directoryCache = zip?.contentRecovery?.directory_cache || {
    source: "unavailable",
    persistent: false,
    bytes: 0,
  };
  const referenceKeys = mediaReferenceKeys(references);
  const resumedByEntry = new Map((Array.isArray(existingAssets) ? existingAssets : [])
    .map((asset) => [Number(asset.entryIndex), asset])
    .filter(([entryIndex]) => Number.isInteger(entryIndex) && entryIndex > 0));
  const uploaded = [];
  const activeTransfers = new Map();
  const checkpointPending = new Map();
  let entries = 0;
  let uncompressedBytes = 0;
  let candidateEntriesSeen = 0;
  let candidateBytesSeen = 0;
  let resumedFilesSeen = 0;
  const resumedFiles = resumedByEntry.size;
  const resumedBytes = expectedResumedBytes;
  let newlyUploaded = 0;
  let newlyUploadedBytes = 0;
  const filesTotal = Number(inventory?.candidateEntries || 0);
  const bytesTotal = Number(inventory?.candidateUncompressedBytes || 0);
  const startedAtMs = Date.now();
  let transferStartedAtMs = null;
  const movementAt = () => new Date().toISOString();
  let lastProgressAt = 0;
  let progressChain = Promise.resolve();
  let batcher;

  const progressSnapshot = (extras = {}) => {
    const active = [...activeTransfers.values()];
    const first = active[0] || null;
    const activeBytes = active.reduce((total, transfer) => total + Math.max(0, Number(transfer.loaded || 0)), 0);
    const pendingBytes = [...checkpointPending.values()]
      .reduce((total, asset) => total + Math.max(0, Number(asset.sizeBytes || 0)), 0);
    const filesProcessed = resumedFiles + newlyUploaded;
    const durableBytes = resumedBytes + newlyUploadedBytes;
    const rate = mediaRateSnapshot({
      startedAtMs: transferStartedAtMs ?? startedAtMs,
      newlyUploaded,
      filesProcessed,
      filesTotal,
    });
    const observedBytes = durableBytes + pendingBytes + activeBytes;
    return {
      stage: "uploading_private_images",
      files_processed: filesProcessed,
      files_total: filesTotal,
      bytes_processed: bytesTotal > 0 ? Math.min(bytesTotal, observedBytes) : observedBytes,
      durable_bytes_processed: durableBytes,
      bytes_total: bytesTotal,
      current_file: first?.originalName || "",
      current_file_bytes: Math.min(Number(first?.loaded || 0), Number(first?.totalBytes || 0)),
      current_file_total_bytes: Number(first?.totalBytes || 0),
      active_files: active.slice(0, workerConcurrency).map((transfer) => transfer.originalName),
      workers_configured: workerConcurrency,
      workers_active: active.length,
      checkpoint_batch_size: assetBatchSize,
      checkpoint_pending: checkpointPending.size,
      resumed_files: resumedFiles,
      resumed_files_validated: resumedFilesSeen,
      recovery_entries_scanned: entries,
      recovery_entries_total: Number(zip.entryCount || 0),
      directory_cache: directoryCache.source,
      directory_cache_bytes: Number(directoryCache.bytes || 0),
      directory_cache_persistent: directoryCache.persistent === true,
      entry_open_timeout_ms: Number(
        zip?.contentRecovery?.entry_open_timeout_ms
          || recoveryConfig.entry_open_timeout_ms,
      ),
      newly_uploaded: newlyUploaded,
      percent: filesTotal > 0 ? Math.min(99, Math.round((filesProcessed / filesTotal) * 100)) : null,
      movement_at: movementAt(),
      ...rate,
      ...extras,
    };
  };

  const emitProgress = async (force = false, extras = {}) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < heartbeatMs) return;
    lastProgressAt = now;
    progressChain = progressChain.then(() => onProgress(progressSnapshot(extras)));
    await progressChain;
  };

  const persistBatch = typeof onAssets === "function"
    ? onAssets
    : async (assets, context) => {
      for (const asset of assets) {
        await onAsset?.(asset, {
          resumed: false,
          entryIndex: asset.entryIndex,
          progress: context.progress,
        });
      }
    };

  batcher = new MediaAssetBatcher({
    batchSize: assetBatchSize,
    intervalMs: assetCheckpointMs,
    onFlush: async (assets) => {
      const batchBytes = assets.reduce((total, asset) => total + Number(asset.sizeBytes || 0), 0);
      const projectedFiles = newlyUploaded + assets.length;
      const projectedBytes = newlyUploadedBytes + batchBytes;
      const lastEntryIndex = assets.reduce(
        (maximum, asset) => Math.max(maximum, Number(asset.entryIndex || 0)),
        0,
      );
      const progress = progressSnapshot({
        files_processed: resumedFiles + projectedFiles,
        bytes_processed: resumedBytes + projectedBytes,
        durable_bytes_processed: resumedBytes + projectedBytes,
        newly_uploaded: projectedFiles,
        checkpoint_pending: Math.max(0, checkpointPending.size - assets.length),
        media_entry_index: lastEntryIndex,
        movement: true,
      });
      await persistBatch(assets, {
        progress,
        firstEntryIndex: Math.min(...assets.map((asset) => Number(asset.entryIndex))),
        lastEntryIndex,
      });
      newlyUploaded = projectedFiles;
      newlyUploadedBytes = projectedBytes;
      for (const asset of assets) checkpointPending.delete(Number(asset.entryIndex));
    },
  });

  let settled = false;
  let terminating = false;
  let rejectScan;
  let recoveryHeartbeatTimer;
  let lastHeartbeatEntries = 0;
  let lastHeartbeatResumed = 0;
  const stopRecoveryHeartbeat = () => {
    if (recoveryHeartbeatTimer) clearInterval(recoveryHeartbeatTimer);
    recoveryHeartbeatTimer = null;
  };
  const abortTransfers = () => {
    for (const transfer of activeTransfers.values()) {
      Promise.resolve(transfer.upload?.abort()).catch(() => {});
    }
  };
  const fail = (error) => {
    if (settled || terminating) return;
    terminating = true;
    stopRecoveryHeartbeat();
    abortTransfers();
    try { zip.close(); } catch { /* Already closed. */ }
    void (async () => {
      await pool.drain().catch(() => {});
      await batcher.flush().catch(() => {});
      await progressChain.catch(() => {});
      settled = true;
      rejectScan?.(error);
    })();
  };
  const pool = new BoundedTaskPool(workerConcurrency, { onError: fail });

  const uploadEntry = async ({ entry, entryIndex, candidate }) => {
    transferStartedAtMs ??= Date.now();
    const { originalName, mediaKind, maxAssetBytes } = candidate;
    const input = await openEntry(zip, entry, {
      timeoutMs: Number(
        zip?.contentRecovery?.entry_open_timeout_ms
          || recoveryConfig.entry_open_timeout_ms,
      ),
    });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxAssetBytes) {
        return callback(Object.assign(new Error(`${mediaKind} exceeds limit: ${originalName}`), { statusCode: 413 }));
      }
      hash.update(chunk);
      callback(null, chunk);
    } });
    const body = new PassThrough();
    input.pipe(meter).pipe(body);
    input.on("error", (error) => body.destroy(error));
    meter.on("error", (error) => body.destroy(error));
    const objectKey = deterministicMediaObjectKey({
      mediaKind,
      examTrack,
      sourceNamespace,
      importJobId,
      mediaImportJobId,
      entryIndex,
      originalName,
    });
    const uploadOptions = { client: adapters.r2Client ?? getContentR2Client(), params: {
      Bucket: adapters.r2Bucket ?? contentR2Bucket(), Key: objectKey, Body: body,
      ContentType: MIME.lookup(originalName) || "application/octet-stream",
      Metadata: {
        exam_track: slug(examTrack),
        source_namespace: slug(sourceNamespace),
        import_job_id: String(importJobId),
        media_import_job_id: String(mediaImportJobId || importJobId),
        media_kind: mediaKind,
      },
    }, queueSize: 1, partSize: 5 * 1024 ** 2, leavePartsOnError: false };
    const upload = typeof adapters.createUpload === "function"
      ? adapters.createUpload(uploadOptions)
      : new Upload(uploadOptions);
    const transfer = {
      originalName,
      loaded: 0,
      totalBytes: Number(entry.uncompressedSize || 0),
      upload,
    };
    activeTransfers.set(entryIndex, transfer);
    upload.on("httpUploadProgress", (progress = {}) => {
      transfer.loaded = Math.max(transfer.loaded, Number(progress.loaded || 0));
    });
    try {
      await waitForMediaUpload(upload, {
        heartbeatMs,
        onProgress: () => emitProgress(false),
      });
      const asset = {
        entryIndex,
        originalName,
        objectKey,
        sha256: hash.digest("hex"),
        sizeBytes: bytes,
        contentType: MIME.lookup(originalName) || "application/octet-stream",
        mediaKind,
      };
      uploaded.push(asset);
      checkpointPending.set(entryIndex, asset);
      await batcher.add(asset);
    } finally {
      activeTransfers.delete(entryIndex);
    }
  };

  recoveryHeartbeatTimer = setInterval(() => {
    const moved = entries !== lastHeartbeatEntries || resumedFilesSeen !== lastHeartbeatResumed;
    lastHeartbeatEntries = entries;
    lastHeartbeatResumed = resumedFilesSeen;
    void emitProgress(true, {
      stage: transferStartedAtMs ? "uploading_private_images" : "validating_media_resume",
      recovery_phase: transferStartedAtMs ? "uploading" : "validating_durable_entries",
      recovery_entries_scanned: entries,
      recovery_entries_total: Number(zip.entryCount || 0),
      resumed_files_validated: resumedFilesSeen,
      movement: moved,
    }).catch(fail);
  }, recoveryHeartbeatIntervalMs);
  recoveryHeartbeatTimer.unref?.();

  await new Promise((resolve, reject) => {
    rejectScan = reject;
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        const entryIndex = entries;
        uncompressedBytes += Number(entry.uncompressedSize || 0);
        validateMediaArchiveProgress(entries, uncompressedBytes);
        const candidate = mediaEntryCandidate(entry, referenceKeys);
        if (!candidate) {
          if (entries % 500 === 0) {
            await emitProgress(false, {
              stage: transferStartedAtMs ? "uploading_private_images" : "validating_media_resume",
              recovery_phase: "scanning_cached_directory",
              recovery_entries_scanned: entries,
              recovery_entries_total: Number(zip.entryCount || 0),
              movement: true,
            });
          }
          if (!settled) zip.readEntry();
          return;
        }
        candidateEntriesSeen += 1;
        candidateBytesSeen += Number(entry.uncompressedSize || 0);

        const staged = resumedByEntry.get(entryIndex);
        if (staged) {
          if (String(staged.originalName) !== String(candidate.originalName)) {
            throw Object.assign(new Error(`Saved media checkpoint does not match ZIP entry ${entryIndex}`), { statusCode: 409 });
          }
          resumedByEntry.delete(entryIndex);
          resumedFilesSeen += 1;
          uploaded.push(staged);
          if (resumedFilesSeen % 500 === 0) {
            await emitProgress(false, {
              stage: "validating_media_resume",
              recovery_phase: "validating_durable_entries",
              recovery_entries_scanned: entries,
              recovery_entries_total: Number(zip.entryCount || 0),
              resumed_files_validated: resumedFilesSeen,
              movement: true,
            });
          }
          if (!settled) zip.readEntry();
          return;
        }

        await pool.schedule(() => uploadEntry({ entry, entryIndex, candidate }));
        if (!settled) zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on("end", async () => {
      if (terminating) return;
      try {
        stopRecoveryHeartbeat();
        await pool.drain();
        await batcher.flush();
        await progressChain;
        if (resumedByEntry.size) {
          throw Object.assign(new Error("Saved media checkpoints refer to entries that are absent from the ZIP"), { statusCode: 409 });
        }
        if (filesTotal && candidateEntriesSeen !== filesTotal) {
          throw Object.assign(new Error("Cached media inventory file count no longer matches the ZIP"), { statusCode: 409 });
        }
        if (bytesTotal && candidateBytesSeen !== bytesTotal) {
          throw Object.assign(new Error("Cached media inventory byte count no longer matches the ZIP"), { statusCode: 409 });
        }
        await emitProgress(true, { workers_active: 0, checkpoint_pending: 0 });
        settled = true;
        try { zip.close(); } catch { /* Already closed. */ }
        resolve();
      } catch (error) {
        fail(error);
      }
    });
    zip.on("error", fail);
    zip.readEntry();
  });
  uploaded.sort((left, right) => Number(left.entryIndex) - Number(right.entryIndex));
  return {
    assets: uploaded,
    entries,
    uncompressedBytes,
    candidateEntries: filesTotal || uploaded.length,
    candidateUncompressedBytes: bytesTotal || resumedBytes + newlyUploadedBytes,
    resumedFiles,
    newlyUploaded,
    workersConfigured: workerConcurrency,
    maximumWorkersActive: pool.maximumActive,
    directoryCache,
  };
}

export async function deleteR2Object(objectKey) {
  await deleteContentR2Object(objectKey);
}

export async function createPrivateMediaUrl(objectKey, expiresIn = 300) {
  return signPrivateContentR2Url(objectKey, Math.max(60, Math.min(900, Number(expiresIn || 300))));
}
