import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  contentR2Bucket,
  getContentR2Client,
  headContentR2Object,
} from "../lib/content-r2-storage.js";

const { Pool } = pg;
const collectionId = String(process.env.CONTENT_MEDIA_RESTORE_COLLECTION_ID || "").trim();
const archiveObjectKey = String(process.env.CONTENT_MEDIA_RESTORE_ARCHIVE_KEY || "").trim();
const apply = String(process.env.CONTENT_MEDIA_RESTORE_APPLY || "").trim().toLowerCase() === "true";
const concurrency = Math.max(1, Math.min(12, Number(process.env.CONTENT_MEDIA_RESTORE_CONCURRENCY || 6)));
const expectedAssets = Math.max(0, Number(process.env.CONTENT_MEDIA_RESTORE_EXPECTED_ASSETS || 0));
const reuseWorkDirectory = String(process.env.CONTENT_MEDIA_RESTORE_REUSE_WORK_DIR || "").trim().toLowerCase() === "true";
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const workDirectory = path.resolve(
  process.env.CONTENT_MEDIA_RESTORE_WORK_DIR || `/tmp/aylamed-media-restore-${collectionId || "invalid"}`,
);

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(collectionId)) {
  throw new Error("CONTENT_MEDIA_RESTORE_COLLECTION_ID must be one collection UUID");
}
if (!archiveObjectKey.startsWith("temporary/aylamed-repair/") || !archiveObjectKey.endsWith(".zip")) {
  throw new Error("CONTENT_MEDIA_RESTORE_ARCHIVE_KEY must name one temporary AylaMed repair ZIP");
}
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const archivePath = path.join(workDirectory, "source.zip");
const extractedDirectory = path.join(workDirectory, "extracted");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  max: 2,
});
const r2 = getContentR2Client();
const bucket = contentR2Bucket();

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function listFiles(directory) {
  const output = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function concurrentMap(items, worker, limit = concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function fetchPublishedAssets() {
  const result = await pool.query(`
    WITH relevant_assets AS (
      SELECT qm.media_asset_id
      FROM content_source_aliases alias
      JOIN content_questions question ON question.id=alias.question_id
      JOIN content_question_media qm ON qm.question_id=question.id
      WHERE alias.collection_id=$1::uuid AND question.status='approved'
      UNION
      SELECT am.media_asset_id
      FROM content_source_aliases alias
      JOIN content_questions question ON question.id=alias.question_id
      JOIN content_source_alias_media am ON am.source_alias_id=alias.id
      WHERE alias.collection_id=$1::uuid AND question.status='approved'
    )
    SELECT asset.id,asset.object_key,asset.original_name,asset.sha256,
      asset.content_type,asset.size_bytes::text
    FROM relevant_assets relevant
    JOIN content_media_assets asset ON asset.id=relevant.media_asset_id
    WHERE COALESCE(NULLIF(asset.object_key,''),'')<>''
      AND LOWER(COALESCE(asset.status,'')) NOT IN ('archived','deleted','rejected','quarantined')
    ORDER BY asset.object_key
  `, [collectionId]);
  return result.rows.map((row) => ({
    ...row,
    sizeBytes: Number(row.size_bytes || 0),
    basename: path.basename(String(row.original_name || "")).toLowerCase(),
  }));
}

await fs.promises.mkdir(extractedDirectory, { recursive: true });
const reusableFiles = reuseWorkDirectory && fs.existsSync(archivePath) && fs.existsSync(extractedDirectory)
  ? await listFiles(extractedDirectory)
  : [];
if (reusableFiles.length) {
  console.log(JSON.stringify({ stage: "reuse_extracted", files: reusableFiles.length, archiveObjectKey, collectionId, apply }));
} else {
  console.log(JSON.stringify({ stage: "download", archiveObjectKey, collectionId, apply }));
  const archive = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: archiveObjectKey }));
  await pipeline(archive.Body, fs.createWriteStream(archivePath));
  await run("unzip", ["-q", "-o", archivePath, "-d", extractedDirectory]);
}

const localPaths = (await listFiles(extractedDirectory))
  .filter((filePath) => !filePath.toLowerCase().endsWith(".zip"));
const localFiles = await concurrentMap(localPaths, async (filePath, index) => {
  const stat = await fs.promises.stat(filePath);
  const row = {
    filePath,
    basename: path.basename(filePath).toLowerCase(),
    sha256: await sha256File(filePath),
    sizeBytes: stat.size,
  };
  if ((index + 1) % 500 === 0) console.log(JSON.stringify({ stage: "hash", checked: index + 1, total: localPaths.length }));
  return row;
});
const localByBasename = new Map();
for (const file of localFiles) {
  if (!localByBasename.has(file.basename)) localByBasename.set(file.basename, []);
  localByBasename.get(file.basename).push(file);
}

const assets = await fetchPublishedAssets();
const planned = [];
const unmatched = [];
for (const asset of assets) {
  const candidates = (localByBasename.get(asset.basename) || [])
    .filter((file) => file.sha256 === String(asset.sha256 || "").toLowerCase());
  if (!candidates.length) unmatched.push({
    objectKey: asset.object_key,
    originalName: asset.original_name,
    reason: (localByBasename.get(asset.basename) || []).length ? "checksum_mismatch" : "filename_missing",
  });
  else planned.push({ asset, file: candidates[0] });
}

if (expectedAssets > 0 && assets.length !== expectedAssets) {
  throw new Error(`Published asset count changed: expected ${expectedAssets}, found ${assets.length}; nothing restored`);
}
if (apply && unmatched.length > 0) {
  console.log(`MEDIA_RESTORE_RESULT ${JSON.stringify({
    success: false,
    apply,
    collectionId,
    localFiles: localFiles.length,
    publishedAssets: assets.length,
    matchedByFilenameAndSha256: planned.length,
    unmatched: unmatched.length,
    unmatchedSamples: unmatched.slice(0, 25),
    restored: 0,
    reason: "preflight_mismatch_nothing_restored",
  })}`);
  await pool.end();
  process.exit(2);
}

const counters = { alreadyPresent: 0, restored: 0, verified: 0, failed: 0 };
const failures = [];
await concurrentMap(planned, async ({ asset, file }, index) => {
  try {
    const prior = await headContentR2Object(asset.object_key).catch(() => null);
    if (prior && Number(prior.sizeBytes || 0) === asset.sizeBytes) {
      counters.alreadyPresent += 1;
    } else if (apply) {
      await r2.send(new PutObjectCommand({
        Bucket: bucket,
        Key: asset.object_key,
        Body: fs.createReadStream(file.filePath),
        ContentLength: file.sizeBytes,
        ContentType: asset.content_type || "application/octet-stream",
        Metadata: {
          "repair-source": "authorized-local-archive",
          "collection-id": collectionId,
          "verified-sha256": file.sha256,
        },
      }));
      counters.restored += 1;
    }
    const verified = await headContentR2Object(asset.object_key).catch(() => null);
    if (verified && Number(verified.sizeBytes || 0) === asset.sizeBytes) counters.verified += 1;
    else if (apply || prior) throw new Error("object_missing_or_size_mismatch_after_restore");
  } catch (error) {
    counters.failed += 1;
    failures.push({ objectKey: asset.object_key, error: error.message });
  }
  if ((index + 1) % 250 === 0) console.log(JSON.stringify({ stage: "restore", checked: index + 1, total: planned.length, ...counters }));
}, concurrency);

const result = {
  success: apply && unmatched.length === 0 && counters.failed === 0 && counters.verified === assets.length,
  apply,
  collectionId,
  archiveObjectKey,
  localFiles: localFiles.length,
  publishedAssets: assets.length,
  matchedByFilenameAndSha256: planned.length,
  unmatched: unmatched.length,
  ...counters,
  unmatchedSamples: unmatched.slice(0, 25),
  failureSamples: failures.slice(0, 25),
  temporaryFilesRetained: true,
};
console.log(`MEDIA_RESTORE_RESULT ${JSON.stringify(result)}`);
await pool.end();
if (apply && !result.success) process.exitCode = 2;
