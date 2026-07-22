import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketCorsCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  PutBucketCorsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client;

function env(name, source = process.env) { return String(source?.[name] || "").trim(); }

export function contentR2Status(source = process.env) {
  const configured = Boolean(
    env("CLOUDFLARE_R2_ACCOUNT_ID", source)
    && env("CLOUDFLARE_R2_ACCESS_KEY_ID", source)
    && env("CLOUDFLARE_R2_SECRET_ACCESS_KEY", source)
    && env("CLOUDFLARE_R2_BUCKET", source)
  );
  return { configured, provider: "cloudflare-r2", bucket: configured ? env("CLOUDFLARE_R2_BUCKET", source) : null };
}

export function getContentR2Client() {
  if (!contentR2Status().configured) throw Object.assign(new Error("Cloudflare R2 is not configured"), { statusCode: 503 });
  if (!client) client = new S3Client({
    region: env("CLOUDFLARE_R2_REGION") || "auto",
    endpoint: env("CLOUDFLARE_R2_ENDPOINT") || `https://${env("CLOUDFLARE_R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env("CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: env("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

export function contentR2Bucket() {
  const bucket = env("CLOUDFLARE_R2_BUCKET");
  if (!bucket) throw Object.assign(new Error("Cloudflare R2 bucket is not configured"), { statusCode: 503 });
  return bucket;
}

export async function createContentR2Multipart({ objectKey, contentType = "application/zip", metadata = {} }) {
  const result = await getContentR2Client().send(new CreateMultipartUploadCommand({
    Bucket: contentR2Bucket(), Key: objectKey, ContentType: contentType, Metadata: metadata,
  }));
  if (!result.UploadId) throw new Error("R2 did not return a multipart upload ID");
  return { uploadId: result.UploadId, objectKey };
}

export async function signContentR2UploadPart({ objectKey, uploadId, partNumber, expiresIn = 900 }) {
  return getSignedUrl(getContentR2Client(), new UploadPartCommand({
    Bucket: contentR2Bucket(), Key: objectKey, UploadId: uploadId, PartNumber: partNumber,
  }), { expiresIn: Math.max(60, Math.min(3600, Number(expiresIn || 900))) });
}

export async function listContentR2Parts({ objectKey, uploadId }) {
  const parts = [];
  let marker;
  do {
    const result = await getContentR2Client().send(new ListPartsCommand({
      Bucket: contentR2Bucket(), Key: objectKey, UploadId: uploadId, PartNumberMarker: marker,
    }));
    parts.push(...(result.Parts || []).map((part) => ({
      PartNumber: Number(part.PartNumber), ETag: String(part.ETag || ""), Size: Number(part.Size || 0),
    })));
    marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

export async function completeContentR2Multipart({ objectKey, uploadId, parts }) {
  await getContentR2Client().send(new CompleteMultipartUploadCommand({
    Bucket: contentR2Bucket(), Key: objectKey, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.PartNumber, ETag: part.ETag })) },
  }));
  return headContentR2Object(objectKey);
}

export async function abortContentR2Multipart({ objectKey, uploadId }) {
  await getContentR2Client().send(new AbortMultipartUploadCommand({
    Bucket: contentR2Bucket(), Key: objectKey, UploadId: uploadId,
  }));
}

export async function headContentR2Object(objectKey) {
  const result = await getContentR2Client().send(new HeadObjectCommand({ Bucket: contentR2Bucket(), Key: objectKey }));
  return { objectKey, sizeBytes: Number(result.ContentLength || 0), etag: String(result.ETag || "").replace(/^"|"$/g, "") };
}

export async function getContentR2ObjectStream(objectKey, { start, endExclusive } = {}) {
  const hasRange = Number.isFinite(start) && Number.isFinite(endExclusive) && endExclusive > start;
  const result = await getContentR2Client().send(new GetObjectCommand({
    Bucket: contentR2Bucket(), Key: objectKey,
    ...(hasRange ? { Range: `bytes=${Math.floor(start)}-${Math.floor(endExclusive) - 1}` } : {}),
  }));
  if (!result.Body) throw new Error("R2 returned an empty object stream");
  return result.Body;
}

export async function signPrivateContentR2Url(objectKey, expiresIn = 300) {
  return getSignedUrl(getContentR2Client(), new GetObjectCommand({ Bucket: contentR2Bucket(), Key: objectKey }), {
    expiresIn: Math.max(60, Math.min(86400, Number(expiresIn || 300))),
  });
}

export async function deleteContentR2Object(objectKey) {
  await getContentR2Client().send(new DeleteObjectCommand({ Bucket: contentR2Bucket(), Key: objectKey }));
}

export async function ensureContentR2BrowserCors(origins = []) {
  const allowedOrigins = [...new Set(origins.map((value) => String(value || "").trim()).filter((value) => /^https:\/\//i.test(value)))];
  if (!allowedOrigins.length) throw new Error("At least one HTTPS origin is required for R2 browser uploads");
  let existing = [];
  try {
    const result = await getContentR2Client().send(new GetBucketCorsCommand({ Bucket: contentR2Bucket() }));
    existing = Array.isArray(result.CORSRules) ? result.CORSRules : [];
  } catch (error) {
    if (!["NoSuchCORSConfiguration", "NoSuchCorsConfiguration", "NoSuchKey"].includes(String(error.name || error.Code || ""))) throw error;
  }
  const managedId = "nextgen-direct-content-upload";
  const preserved = existing.filter((rule) => String(rule.ID || "") !== managedId);
  const managed = {
    ID: managedId,
    AllowedOrigins: allowedOrigins,
    AllowedMethods: ["PUT", "GET", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  };
  await getContentR2Client().send(new PutBucketCorsCommand({
    Bucket: contentR2Bucket(), CORSConfiguration: { CORSRules: [...preserved, managed] },
  }));
  return managed;
}
