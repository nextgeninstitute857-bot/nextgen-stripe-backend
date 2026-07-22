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

export async function uploadMediaZipToR2({ zipFile, zipSource = zipFile, references = [], examTrack, sourceNamespace, importJobId, onAsset }) {
  const zip = await openContentZip(zipSource);
  const referenceKeys = new Set(references.flatMap((reference) => mediaMatchKeys(reference.mediaRef)));
  const uploaded = [];
  let entries = 0;
  let uncompressedBytes = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_MEDIA_ENTRIES) throw Object.assign(new Error("Media ZIP has too many entries"), { statusCode: 413 });
        uncompressedBytes += Number(entry.uncompressedSize || 0);
        if (uncompressedBytes > MAX_MEDIA_UNCOMPRESSED_BYTES) throw Object.assign(new Error("Media ZIP expands beyond the configured safety limit"), { statusCode: 413 });
        const originalName = safeMediaEntryName(entry.fileName);
        if (!originalName) { zip.readEntry(); return; }
        if (referenceKeys.size && !mediaMatchKeys(originalName).some((key) => referenceKeys.has(key))) { zip.readEntry(); return; }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw Object.assign(new Error("Encrypted media ZIP entries are not supported"), { statusCode: 400 });
        const mediaKind = contentMediaKind(originalName);
        const maxAssetBytes = mediaKind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
        if (Number(entry.uncompressedSize || 0) > maxAssetBytes) throw Object.assign(new Error(`${mediaKind} exceeds limit: ${originalName}`), { statusCode: 413 });
        const input = await openContentZipEntry(zip, entry);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxAssetBytes) return callback(Object.assign(new Error(`${mediaKind} exceeds limit: ${originalName}`), { statusCode: 413 }));
          hash.update(chunk); callback(null, chunk);
        } });
        const body = new PassThrough(); input.pipe(meter).pipe(body);
        input.on("error", (error) => body.destroy(error)); meter.on("error", (error) => body.destroy(error));
        const objectKey = `content/${mediaKind}/${slug(examTrack)}/${slug(sourceNamespace)}/${importJobId}/${crypto.randomUUID()}-${path.basename(originalName)}`;
        const upload = new Upload({ client: getContentR2Client(), params: {
          Bucket: contentR2Bucket(), Key: objectKey, Body: body,
          ContentType: MIME.lookup(originalName) || "application/octet-stream",
          Metadata: { exam_track: slug(examTrack), source_namespace: slug(sourceNamespace), import_job_id: String(importJobId), media_kind: mediaKind },
        }, queueSize: 1, partSize: 5 * 1024 ** 2, leavePartsOnError: false });
        await upload.done();
        const asset = { originalName, objectKey, sha256: hash.digest("hex"), sizeBytes: bytes, contentType: MIME.lookup(originalName) || "application/octet-stream", mediaKind };
        uploaded.push(asset); await onAsset?.(asset); zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on("end", resolve); zip.on("error", reject); zip.readEntry();
  });
  return { assets: uploaded, entries, uncompressedBytes };
}

export async function deleteR2Object(objectKey) {
  await deleteContentR2Object(objectKey);
}

export async function createPrivateMediaUrl(objectKey, expiresIn = 300) {
  return signPrivateContentR2Url(objectKey, Math.max(60, Math.min(900, Number(expiresIn || 300))));
}
