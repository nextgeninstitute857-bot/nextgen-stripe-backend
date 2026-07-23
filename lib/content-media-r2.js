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
  return { ...contentR2Status(source), public_access: false, supported_media: ["image", "audio"] };
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

export async function inspectMediaZip({ zipFile, zipSource = zipFile, references = [], onProgress }) {
  const zip = await openContentZip(zipSource);
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
    const result = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve({ complete: false }), heartbeatMs)),
    ]);
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
  onAsset,
  onProgress,
}) {
  const zip = await openContentZip(zipSource);
  const referenceKeys = mediaReferenceKeys(references);
  const resumedByEntry = new Map((Array.isArray(existingAssets) ? existingAssets : [])
    .map((asset) => [Number(asset.entryIndex), asset])
    .filter(([entryIndex]) => Number.isInteger(entryIndex) && entryIndex > 0));
  const uploaded = [];
  let entries = 0;
  let uncompressedBytes = 0;
  let filesProcessed = 0;
  let bytesProcessed = 0;
  let resumedFiles = 0;
  let newlyUploaded = 0;
  const filesTotal = Number(inventory?.candidateEntries || 0);
  const bytesTotal = Number(inventory?.candidateUncompressedBytes || 0);
  const movementAt = () => new Date().toISOString();
  const completedProgress = (currentFile = "", extras = {}) => ({
    stage: "uploading_private_images",
    files_processed: filesProcessed,
    files_total: filesTotal,
    bytes_processed: bytesProcessed,
    bytes_total: bytesTotal,
    current_file: currentFile,
    current_file_bytes: 0,
    current_file_total_bytes: 0,
    resumed_files: resumedFiles,
    newly_uploaded: newlyUploaded,
    percent: filesTotal > 0 ? Math.min(99, Math.round((filesProcessed / filesTotal) * 100)) : 99,
    movement_at: movementAt(),
    ...extras,
  });

  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        const entryIndex = entries;
        uncompressedBytes += Number(entry.uncompressedSize || 0);
        validateMediaArchiveProgress(entries, uncompressedBytes);
        const candidate = mediaEntryCandidate(entry, referenceKeys);
        if (!candidate) {
          zip.readEntry();
          return;
        }

        const { originalName, mediaKind, maxAssetBytes } = candidate;
        const staged = resumedByEntry.get(entryIndex);
        if (staged) {
          if (String(staged.originalName) !== String(originalName)) {
            throw Object.assign(new Error(`Saved media checkpoint does not match ZIP entry ${entryIndex}`), { statusCode: 409 });
          }
          filesProcessed += 1;
          bytesProcessed += Number(staged.sizeBytes || entry.uncompressedSize || 0);
          resumedFiles += 1;
          const progress = completedProgress(originalName);
          await onAsset?.(staged, { resumed: true, entryIndex, progress });
          uploaded.push(staged);
          zip.readEntry();
          return;
        }

        const input = await openContentZipEntry(zip, entry);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        let transferLoaded = 0;
        let lastReportedLoaded = 0;
        const meter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxAssetBytes) return callback(Object.assign(new Error(`${mediaKind} exceeds limit: ${originalName}`), { statusCode: 413 }));
          hash.update(chunk); callback(null, chunk);
        } });
        const body = new PassThrough(); input.pipe(meter).pipe(body);
        input.on("error", (error) => body.destroy(error)); meter.on("error", (error) => body.destroy(error));
        const objectKey = deterministicMediaObjectKey({
          mediaKind,
          examTrack,
          sourceNamespace,
          importJobId,
          mediaImportJobId,
          entryIndex,
          originalName,
        });
        const upload = new Upload({ client: getContentR2Client(), params: {
          Bucket: contentR2Bucket(), Key: objectKey, Body: body,
          ContentType: MIME.lookup(originalName) || "application/octet-stream",
          Metadata: {
            exam_track: slug(examTrack),
            source_namespace: slug(sourceNamespace),
            import_job_id: String(importJobId),
            media_import_job_id: String(mediaImportJobId || importJobId),
            media_kind: mediaKind,
          },
        }, queueSize: 1, partSize: 5 * 1024 ** 2, leavePartsOnError: false });
        upload.on("httpUploadProgress", (progress = {}) => {
          transferLoaded = Math.max(transferLoaded, Number(progress.loaded || 0));
        });
        await waitForMediaUpload(upload, {
          onProgress,
          progressSnapshot: () => {
            const moving = transferLoaded > lastReportedLoaded;
            if (moving) lastReportedLoaded = transferLoaded;
            return {
              stage: "uploading_private_images",
              files_processed: filesProcessed,
              files_total: filesTotal,
              bytes_processed: bytesProcessed + transferLoaded,
              bytes_total: bytesTotal,
              current_file: originalName,
              current_file_bytes: transferLoaded,
              current_file_total_bytes: Number(entry.uncompressedSize || 0),
              resumed_files: resumedFiles,
              newly_uploaded: newlyUploaded,
              percent: filesTotal > 0 ? Math.min(99, Math.round((filesProcessed / filesTotal) * 100)) : null,
              movement: moving,
            };
          },
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
        filesProcessed += 1;
        bytesProcessed += bytes;
        newlyUploaded += 1;
        const progress = completedProgress(originalName);
        await onAsset?.(asset, { resumed: false, entryIndex, progress });
        uploaded.push(asset);
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
    assets: uploaded,
    entries,
    uncompressedBytes,
    candidateEntries: filesTotal || uploaded.length,
    candidateUncompressedBytes: bytesTotal || bytesProcessed,
    resumedFiles,
    newlyUploaded,
  };
}

export async function deleteR2Object(objectKey) {
  await deleteContentR2Object(objectKey);
}

export async function createPrivateMediaUrl(objectKey, expiresIn = 300) {
  return signPrivateContentR2Url(objectKey, Math.max(60, Math.min(900, Number(expiresIn || 300))));
}
