import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import axios from "axios";
import { mediaMatchKeys } from "./content-import-adapter.js";
import { openContentZip, openContentZipEntry, openNamedContentZipEntry } from "./content-zip-source.js";
import {
  isProviderRateLimit,
  providerRetryAfterMs,
  withProviderRateLimitBackoff,
} from "./multi-qbank-ingestion.js";
import { matchReferencedAssets } from "./content-media-matcher.js";
import {
  contentPathMatchesEdition,
  normalizeContentEdition,
} from "./content-edition-scope.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".mpeg", ".mpg", ".wmv",
]);
const MAX_VIDEO_BYTES = Math.max(1024 ** 2, Number(process.env.NEXTGEN_CONTENT_MAX_VIDEO_BYTES || 5 * 1024 ** 3));
const MAX_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_MEDIA_ENTRIES || 100000));
const VIDEO_HEARTBEAT_MS = Math.max(5_000, Math.min(60_000, Number(process.env.NEXTGEN_CONTENT_MEDIA_HEARTBEAT_MS || 15_000)));

function env(name, source = process.env) { return String(source?.[name] || "").trim(); }

export function contentVideoStatus(source = process.env) {
  const token = env("VIMEO_ACCESS_TOKEN", source) || env("VIMEO_TOKEN", source);
  return {
    configured: Boolean(token),
    provider: "vimeo",
    privacy: "unlisted",
    embedded_playback: true,
    upload_idle_timeout_ms: Math.max(30_000, Math.min(15 * 60 * 1000, Number(env("NEXTGEN_CONTENT_VIMEO_IDLE_TIMEOUT_MS", source)) || 120_000)),
  };
}

export function isVideoMediaRef(value) {
  const clean = String(value || "").split(/[?#]/, 1)[0];
  return VIDEO_EXTENSIONS.has(path.extname(clean).toLowerCase());
}

export function safeVideoEntryName(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw) || raw.split("/").includes("..") || raw.endsWith("/")) return null;
  return isVideoMediaRef(raw) ? raw : null;
}

export async function inspectContentVideoEntries({
  zipFile,
  zipSource = zipFile,
  edition,
  directoryCacheKey = "",
  onProgress,
}) {
  const cleanEdition = normalizeContentEdition(edition);
  if (!cleanEdition) {
    throw Object.assign(new Error("A four-digit content edition is required"), {
      statusCode: 400,
    });
  }
  const videos = [];
  const zip = await openContentZip(zipSource, { directoryCacheKey });
  let entries = 0;
  let lastProgressAt = Date.now();
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ENTRIES) {
          throw Object.assign(new Error("Video ZIP has too many entries"), {
            statusCode: 413,
          });
        }
        const originalName = safeVideoEntryName(entry.fileName);
        if (originalName && contentPathMatchesEdition(originalName, cleanEdition)) {
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw Object.assign(
              new Error("Encrypted video ZIP entries are not supported"),
              { statusCode: 400 },
            );
          }
          const sizeBytes = Number(entry.uncompressedSize || 0);
          if (sizeBytes > MAX_VIDEO_BYTES) {
            throw Object.assign(
              new Error(`Video exceeds limit: ${originalName}`),
              { statusCode: 413 },
            );
          }
          videos.push({
            originalName,
            entryName: String(entry.fileName),
            zipSource,
            sizeBytes,
            crc32: Number(entry.crc32 || 0),
          });
        }
        const now = Date.now();
        if (onProgress && (
          entries % 500 === 0
          || now - lastProgressAt >= VIDEO_HEARTBEAT_MS
          || entries === Number(zip.entryCount || 0)
        )) {
          lastProgressAt = now;
          await onProgress({
            stage: "inventorying_edition_videos",
            edition: cleanEdition,
            files_processed: entries,
            files_total: Number(zip.entryCount || 0),
            videos_found: videos.length,
            percent: Number(zip.entryCount || 0) > 0
              ? Math.min(100, Math.round((entries / Number(zip.entryCount)) * 100))
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
  return { videos, entries, edition: cleanEdition };
}

export async function extractReferencedVideos({
  zipFile,
  zipSource = zipFile,
  references = [],
  edition = "",
  directoryCacheKey = "",
  onProgress,
}) {
  const cleanEdition = normalizeContentEdition(edition);
  const keys = new Set(references.flatMap((reference) => mediaMatchKeys(reference.mediaRef)));
  const videos = [];
  const zip = await openContentZip(zipSource, { directoryCacheKey });
  let entries = 0;
  let lastProgressAt = Date.now();
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entries += 1;
        if (entries > MAX_ENTRIES) throw Object.assign(new Error("Video ZIP has too many entries"), { statusCode: 413 });
        const originalName = safeVideoEntryName(entry.fileName);
        const inEdition = !cleanEdition
          || contentPathMatchesEdition(originalName, cleanEdition);
        const isCandidate = Boolean(originalName)
          && inEdition
          && (cleanEdition
            || mediaMatchKeys(originalName).some((key) => keys.has(key)));
        if (!isCandidate) {
          const now = Date.now();
          if (onProgress && (entries % 500 === 0 || now - lastProgressAt >= VIDEO_HEARTBEAT_MS)) {
            lastProgressAt = now;
            await onProgress({
              stage: "extracting_private_videos",
              files_processed: entries,
              files_total: Number(zip.entryCount || 0),
              videos_found: videos.length,
              ...(cleanEdition ? { edition: cleanEdition } : {}),
              percent: Number(zip.entryCount || 0) > 0
                ? Math.min(99, Math.round((entries / Number(zip.entryCount)) * 100))
                : null,
            });
          }
          zip.readEntry();
          return;
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw Object.assign(new Error("Encrypted video ZIP entries are not supported"), { statusCode: 400 });
        const expected = Number(entry.uncompressedSize || 0);
        if (expected > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Video exceeds limit: ${originalName}`), { statusCode: 413 });
        const input = await openContentZipEntry(zip, entry);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        for await (const chunk of input) {
          bytes += chunk.length;
          if (bytes > MAX_VIDEO_BYTES) throw Object.assign(new Error(`Video exceeds limit: ${originalName}`), { statusCode: 413 });
          hash.update(chunk);
          const now = Date.now();
          if (onProgress && now - lastProgressAt >= VIDEO_HEARTBEAT_MS) {
            lastProgressAt = now;
            await onProgress({
              stage: "extracting_private_videos",
              files_processed: Math.max(0, entries - 1),
              files_total: Number(zip.entryCount || 0),
              videos_found: videos.length,
              ...(cleanEdition ? { edition: cleanEdition } : {}),
              current_file: originalName,
              current_file_bytes: bytes,
              current_file_total_bytes: expected,
              movement: true,
              percent: Number(zip.entryCount || 0) > 0
                ? Math.min(99, Math.round(((entries - 1) / Number(zip.entryCount)) * 100))
                : null,
            });
          }
        }
        if (expected && bytes !== expected) throw Object.assign(new Error(`Video size mismatch: ${originalName}`), { statusCode: 400 });
        videos.push({
          originalName,
          entryName: String(entry.fileName),
          zipSource,
          sizeBytes: bytes,
          sha256: hash.digest("hex"),
          directoryCacheKey: String(directoryCacheKey || ""),
        });
        await onProgress?.({
          stage: "extracting_private_videos",
          files_processed: entries,
          files_total: Number(zip.entryCount || 0),
          videos_found: videos.length,
          ...(cleanEdition ? { edition: cleanEdition } : {}),
          current_file: originalName,
          current_file_bytes: bytes,
          current_file_total_bytes: expected,
          movement: true,
          percent: Number(zip.entryCount || 0) > 0
            ? Math.min(99, Math.round((entries / Number(zip.entryCount)) * 100))
            : null,
        });
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on("end", resolve); zip.on("error", reject); zip.readEntry();
  });
  return { videos, entries };
}

export function openReferencedVideoStream(video) {
  if (video?.localFile) return Promise.resolve(fs.createReadStream(video.localFile));
  return openNamedContentZipEntry(
    video?.zipSource,
    video?.entryName || video?.originalName,
    { directoryCacheKey: video?.directoryCacheKey || "" },
  );
}

export function matchVideoReferences(references = [], videos = []) {
  return matchReferencedAssets(references, videos, { matchField: "video" });
}

async function* skipReadableBytes(input, offset = 0) {
  let remaining = Math.max(0, Number(offset) || 0);
  for await (const chunk of input) {
    if (!remaining) {
      yield chunk;
      continue;
    }
    if (chunk.length <= remaining) {
      remaining -= chunk.length;
      continue;
    }
    yield chunk.subarray(remaining);
    remaining = 0;
  }
  if (remaining) throw new Error("Vimeo resume offset exceeds the source video size");
}

export async function uploadVideoToVimeo({
  file,
  stream,
  streamFactory,
  sizeBytes,
  name,
  description = "",
  onProgress,
  rateLimitAttempts,
  adapters = {},
}) {
  const token = env("VIMEO_ACCESS_TOKEN") || env("VIMEO_TOKEN");
  if (!token && !adapters.apiClient) throw Object.assign(new Error("Vimeo access token is not configured"), { statusCode: 503 });
  const api = adapters.apiClient || axios.create({
    baseURL: "https://api.vimeo.com",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.vimeo.*+json;version=3.4" },
    timeout: 30_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  const http = adapters.httpClient || axios;
  const attempts = Math.max(1, Math.min(
    8,
    Number(rateLimitAttempts || env("NEXTGEN_CONTENT_VIMEO_RATE_LIMIT_ATTEMPTS") || 6),
  ));
  const retryOptions = {
    maxAttempts: attempts,
    baseDelayMs: Math.max(250, Number(env("NEXTGEN_CONTENT_VIMEO_RATE_LIMIT_BASE_MS")) || 2_000),
    maximumDelayMs: Math.max(1_000, Number(env("NEXTGEN_CONTENT_VIMEO_RATE_LIMIT_MAX_MS")) || 15 * 60 * 1000),
    ...(typeof adapters.sleep === "function" ? { sleep: adapters.sleep } : {}),
    ...(typeof adapters.random === "function" ? { random: adapters.random } : {}),
  };
  const created = await withProviderRateLimitBackoff(() => api.post("/me/videos", {
    upload: { approach: "tus", size: String(sizeBytes) },
    name,
    description,
    privacy: {
      view: "unlisted",
      embed: "whitelist",
      download: false,
      add: false,
      comments: "nobody",
    },
  }), {
    ...retryOptions,
    onRetry: ({ attempt, delayMs }) => onProgress?.({
      loaded: 0,
      total: Number(sizeBytes || 0),
      rate_limited: true,
      retry_attempt: attempt,
      retry_in_ms: delayMs,
      stage: "waiting_for_vimeo_rate_limit",
    }),
  });
  const uploadLink = created.data?.upload?.upload_link;
  const uri = created.data?.uri;
  if (!uploadLink || !uri) throw new Error("Vimeo did not return an upload link and video URI");
  let oneShotStream = stream || null;
  const sourceFactory = typeof streamFactory === "function"
    ? streamFactory
    : file
      ? () => fs.createReadStream(file)
      : oneShotStream
        ? () => {
            if (!oneShotStream) throw Object.assign(
              new Error("A replayable video stream is required to resume a rate-limited Vimeo upload"),
              { statusCode: 409 },
            );
            const current = oneShotStream;
            oneShotStream = null;
            return current;
          }
        : null;
  if (!sourceFactory) throw new Error("A video stream or stream factory is required for Vimeo upload");
  const idleTimeoutMs = contentVideoStatus().upload_idle_timeout_ms;
  const hardTimeoutMs = Math.max(10 * 60 * 1000, Math.min(6 * 60 * 60 * 1000, Number(env("NEXTGEN_CONTENT_VIMEO_REQUEST_TIMEOUT_MS")) || 2 * 60 * 60 * 1000));
  let lastCallbackAt = 0;
  let progressChain = Promise.resolve();
  let progressError = null;

  const tusOffset = async () => {
    const response = await withProviderRateLimitBackoff(() => http.head(uploadLink, {
      headers: { "Tus-Resumable": "1.0.0" },
      timeout: 30_000,
    }), retryOptions);
    const offset = Number(
      response.headers?.["upload-offset"]
      ?? response.headers?.["Upload-Offset"]
      ?? 0,
    );
    if (!Number.isFinite(offset) || offset < 0 || offset > Number(sizeBytes || 0)) {
      throw new Error("Vimeo returned an invalid resumable upload offset");
    }
    return offset;
  };

  const patchFromOffset = async (offset) => {
    const input = await sourceFactory();
    const body = offset > 0
      ? Readable.from(skipReadableBytes(input, offset))
      : input;
    const controller = new AbortController();
    let idleTimer;
    let hardTimer;
    const abortForTimeout = (message) => {
      if (!controller.signal.aborted) controller.abort(new Error(message));
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortForTimeout("Vimeo upload stopped transferring bytes"), idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdleTimer();
    hardTimer = setTimeout(() => abortForTimeout("Vimeo upload exceeded the maximum request time"), hardTimeoutMs);
    hardTimer.unref?.();
    try {
      await http.patch(uploadLink, body, {
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
          "Content-Length": String(Math.max(0, Number(sizeBytes || 0) - offset)),
        },
        signal: controller.signal,
        timeout: 0,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        onUploadProgress: (progress = {}) => {
          resetIdleTimer();
          const loaded = Math.min(Number(sizeBytes || 0), offset + Number(progress.loaded || 0));
          const now = Date.now();
          if (!onProgress || (now - lastCallbackAt < VIDEO_HEARTBEAT_MS && loaded < Number(sizeBytes || 0))) return;
          lastCallbackAt = now;
          progressChain = progressChain
            .then(() => onProgress({ loaded, total: Number(sizeBytes || progress.total || 0) }))
            .catch((error) => {
              progressError = error;
              if (!controller.signal.aborted) controller.abort(error);
            });
        },
      });
      await progressChain;
      if (progressError) throw progressError;
    } catch (error) {
      if (controller.signal.aborted && !progressError) {
        throw Object.assign(new Error(controller.signal.reason?.message || "Vimeo upload timed out"), { statusCode: 504 });
      }
      throw error;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    }
  };

  let offset = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await patchFromOffset(offset);
      offset = Number(sizeBytes || 0);
      break;
    } catch (error) {
      if (!isProviderRateLimit(error) || attempt >= attempts || progressError) throw error;
      offset = await tusOffset();
      if (offset >= Number(sizeBytes || 0)) break;
      const delayMs = providerRetryAfterMs(error, {
        fallbackMs: retryOptions.baseDelayMs * (2 ** (attempt - 1)),
        maximumMs: retryOptions.maximumDelayMs,
      });
      await onProgress?.({
        loaded: offset,
        total: Number(sizeBytes || 0),
        rate_limited: true,
        retry_attempt: attempt,
        retry_in_ms: delayMs,
        stage: "waiting_for_vimeo_rate_limit",
      });
      await (retryOptions.sleep || ((value) => new Promise((resolve) => setTimeout(resolve, value))))(delayMs);
    }
  }
  const id = String(uri).split("/").filter(Boolean).pop();
  return { provider: "vimeo", providerUri: uri, providerId: id, embedUrl: `https://player.vimeo.com/video/${encodeURIComponent(id)}`, status: "transcoding" };
}
