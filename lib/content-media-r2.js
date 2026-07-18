import crypto from "node:crypto";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { createRequire } from "node:module";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import yauzl from "yauzl";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mediaMatchKeys, slug } from "./content-import-adapter.js";

const require = createRequire(import.meta.url);
const MIME = require("mime-types");
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_IMAGE_BYTES || 50 * 1024 ** 2));
const MAX_MEDIA_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_ENTRIES || 100000));
const MAX_MEDIA_UNCOMPRESSED_BYTES = Math.max(MAX_IMAGE_BYTES, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_UNCOMPRESSED_BYTES || 10 * 1024 ** 3));
let client;

function env(name) { return String(process.env[name] || "").trim(); }

export function contentMediaStatus(source = process.env) {
  const read = (name) => String(source?.[name] || "").trim();
  const configured = Boolean(read("CLOUDFLARE_R2_ACCOUNT_ID") && read("CLOUDFLARE_R2_ACCESS_KEY_ID") && read("CLOUDFLARE_R2_SECRET_ACCESS_KEY") && read("CLOUDFLARE_R2_BUCKET"));
  return { configured, provider: "cloudflare-r2", bucket: configured ? read("CLOUDFLARE_R2_BUCKET") : null, public_access: false };
}

function getClient() {
  if (!contentMediaStatus().configured) throw Object.assign(new Error("Cloudflare R2 is not configured"), { statusCode: 503 });
  if (!client) client = new S3Client({
    region: env("CLOUDFLARE_R2_REGION") || "auto",
    endpoint: env("CLOUDFLARE_R2_ENDPOINT") || `https://${env("CLOUDFLARE_R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env("CLOUDFLARE_R2_ACCESS_KEY_ID"), secretAccessKey: env("CLOUDFLARE_R2_SECRET_ACCESS_KEY") },
  });
  return client;
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

export function safeMediaEntryName(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) return null;
  const normalized = raw;
  if (!normalized || normalized.split("/").includes("..") || normalized.endsWith("/")) return null;
  return IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase()) ? normalized : null;
}

export function matchMediaReferences(references = [], assets = []) {
  const byKey = new Map();
  for (const asset of assets) for (const key of mediaMatchKeys(asset.originalName)) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(asset);
  }
  const matches = [];
  const missing = [];
  const ambiguous = [];
  const used = new Set();
  for (const reference of references) {
    const candidates = new Map();
    for (const key of mediaMatchKeys(reference.mediaRef)) for (const asset of byKey.get(key) || []) candidates.set(asset.sha256, asset);
    if (candidates.size === 1) {
      const asset = [...candidates.values()][0]; used.add(asset.sha256); matches.push({ ...reference, asset });
    } else if (candidates.size === 0) missing.push(reference);
    else ambiguous.push({ ...reference, candidates: [...candidates.values()].map((asset) => asset.originalName) });
  }
  return { matches, missing, ambiguous, unreferenced: assets.filter((asset) => !used.has(asset.sha256)) };
}

export async function uploadMediaZipToR2({ zipFile, examTrack, sourceNamespace, importJobId, onAsset }) {
  const zip = await openZip(zipFile);
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
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw Object.assign(new Error("Encrypted media ZIP entries are not supported"), { statusCode: 400 });
        if (Number(entry.uncompressedSize || 0) > MAX_IMAGE_BYTES) throw Object.assign(new Error(`Image exceeds limit: ${originalName}`), { statusCode: 413 });
        const input = await openEntry(zip, entry);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        const meter = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_IMAGE_BYTES) return callback(Object.assign(new Error(`Image exceeds limit: ${originalName}`), { statusCode: 413 }));
          hash.update(chunk); callback(null, chunk);
        } });
        const body = new PassThrough(); input.pipe(meter).pipe(body);
        input.on("error", (error) => body.destroy(error)); meter.on("error", (error) => body.destroy(error));
        const objectKey = `${slug(examTrack)}/${slug(sourceNamespace)}/${importJobId}/${crypto.randomUUID()}-${path.basename(originalName)}`;
        const upload = new Upload({ client: getClient(), params: {
          Bucket: env("CLOUDFLARE_R2_BUCKET"), Key: objectKey, Body: body,
          ContentType: MIME.lookup(originalName) || "application/octet-stream",
          Metadata: { exam_track: slug(examTrack), source_namespace: slug(sourceNamespace), import_job_id: String(importJobId) },
        }, queueSize: 1, partSize: 5 * 1024 ** 2, leavePartsOnError: false });
        await upload.done();
        const asset = { originalName, objectKey, sha256: hash.digest("hex"), sizeBytes: bytes, contentType: MIME.lookup(originalName) || "application/octet-stream" };
        uploaded.push(asset); await onAsset?.(asset); zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on("end", resolve); zip.on("error", reject); zip.readEntry();
  });
  return { assets: uploaded, entries, uncompressedBytes };
}

export async function deleteR2Object(objectKey) {
  await getClient().send(new DeleteObjectCommand({ Bucket: env("CLOUDFLARE_R2_BUCKET"), Key: objectKey }));
}

export async function createPrivateMediaUrl(objectKey, expiresIn = 300) {
  return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: env("CLOUDFLARE_R2_BUCKET"), Key: objectKey }), { expiresIn: Math.max(60, Math.min(900, Number(expiresIn || 300))) });
}
