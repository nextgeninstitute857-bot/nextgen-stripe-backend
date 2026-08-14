import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SEARCH_BYTES = 65_557;
const CACHE_VERSION = 1;
const preparations = new Map();

function statusError(message, statusCode = 500, code = "") {
  return Object.assign(new Error(message), {
    statusCode,
    ...(code ? { code } : {}),
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function clean(value) {
  return String(value || "").trim();
}

export function contentZipRecoveryConfig(source = process.env) {
  const dataDir = clean(source.DATA_DIR) || "/var/data";
  return {
    cache_dir: clean(source.NEXTGEN_CONTENT_ZIP_DIRECTORY_CACHE_DIR)
      || path.join(dataDir, "content-zip-directory-cache"),
    cache_max_bytes: boundedInteger(
      source.NEXTGEN_CONTENT_ZIP_DIRECTORY_CACHE_MAX_BYTES,
      128 * 1024 ** 2,
      1024 ** 2,
      512 * 1024 ** 2,
    ),
    cache_memory_max_bytes: boundedInteger(
      source.NEXTGEN_CONTENT_ZIP_DIRECTORY_CACHE_MEMORY_BYTES,
      64 * 1024 ** 2,
      1024 ** 2,
      256 * 1024 ** 2,
    ),
    range_timeout_ms: boundedInteger(
      source.NEXTGEN_CONTENT_ZIP_RANGE_TIMEOUT_MS,
      45_000,
      5_000,
      5 * 60_000,
    ),
    entry_open_timeout_ms: boundedInteger(
      source.NEXTGEN_CONTENT_ZIP_ENTRY_OPEN_TIMEOUT_MS,
      45_000,
      5_000,
      5 * 60_000,
    ),
    heartbeat_ms: boundedInteger(
      source.NEXTGEN_CONTENT_ZIP_RECOVERY_HEARTBEAT_MS,
      10_000,
      5_000,
      60_000,
    ),
  };
}

function sourceIdentity(source = {}, cacheKey = "") {
  return {
    object_key: clean(source.objectKey),
    size_bytes: Math.max(0, Number(source.sizeBytes || 0)),
    etag: clean(source.etag).replace(/^"|"$/g, ""),
    cache_key: clean(cacheKey),
  };
}

function cacheBasename(identity) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

function safeUInt64(buffer, offset, label) {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw statusError(`ZIP64 ${label} is truncated`, 400, "CONTENT_ZIP_DIRECTORY_INVALID");
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw statusError(`ZIP64 ${label} exceeds the supported safe integer range`, 413, "CONTENT_ZIP_DIRECTORY_TOO_LARGE");
  }
  return Number(value);
}

function findLastSignature(buffer, signature) {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

async function report(onProgress, value) {
  if (typeof onProgress === "function") await onProgress(value);
}

async function readRangeBuffer({
  fetchRange,
  start,
  endExclusive,
  timeoutMs,
  maximumBytes,
  heartbeatMs,
  onProgress,
  phase,
}) {
  const expectedBytes = Math.max(0, Number(endExclusive) - Number(start));
  if (expectedBytes > maximumBytes) {
    throw statusError(
      `ZIP directory recovery range exceeds ${maximumBytes} bytes`,
      413,
      "CONTENT_ZIP_DIRECTORY_TOO_LARGE",
    );
  }
  const chunks = [];
  const maximumAttempts = 3;
  let received = 0;
  let lastError = null;
  let lastReportAt = Date.now();

  for (let attempt = 1; attempt <= maximumAttempts && received < expectedBytes; attempt += 1) {
    const controller = new AbortController();
    const timeoutError = statusError(
      `R2 ZIP directory read timed out after ${timeoutMs}ms`,
      504,
      "CONTENT_ZIP_RANGE_TIMEOUT",
    );
    let body = null;
    let timer = null;
    try {
      body = await new Promise((resolve, reject) => {
        let settled = false;
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
        timer.unref?.();
        Promise.resolve(fetchRange({
          start: Number(start) + received,
          endExclusive,
          signal: controller.signal,
        })).then((value) => {
          if (settled) {
            value?.destroy?.();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });

      await new Promise((resolve, reject) => {
        let finished = false;
        let reportChain = Promise.resolve();
        const resetTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            controller.abort();
            body?.destroy?.();
            finish(timeoutError);
          }, timeoutMs);
          timer.unref?.();
        };
        const removeListeners = () => {
          body?.removeAllListeners?.("data");
          body?.removeAllListeners?.("end");
          body?.removeAllListeners?.("error");
          body?.removeAllListeners?.("aborted");
          body?.removeAllListeners?.("close");
        };
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          removeListeners();
          if (error) {
            body?.destroy?.();
            reject(error);
            return;
          }
          reportChain.then(resolve, reject);
        };
        resetTimer();
        body.on("data", (chunk) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += value.length;
          if (received > expectedBytes || received > maximumBytes) {
            finish(statusError(
              "R2 ZIP directory read exceeded the requested safety bounds",
              413,
              "CONTENT_ZIP_DIRECTORY_TOO_LARGE",
            ));
            return;
          }
          chunks.push(value);
          resetTimer();
          const now = Date.now();
          if (now - lastReportAt >= heartbeatMs) {
            lastReportAt = now;
            reportChain = reportChain.then(() => report(onProgress, {
              phase,
              bytes_loaded: received,
              bytes_total: expectedBytes,
              movement: true,
            }));
            reportChain.catch(finish);
          }
        });
        body.once("end", () => finish(
          received === expectedBytes
            ? null
            : statusError(
              `R2 ZIP directory range was truncated (${received}/${expectedBytes} bytes)`,
              502,
              "CONTENT_ZIP_RANGE_TRUNCATED",
            ),
        ));
        body.once("error", finish);
        body.once("aborted", () => finish(timeoutError));
        body.once("close", () => {
          if (received < expectedBytes) finish(statusError(
            `R2 ZIP directory range closed at ${received}/${expectedBytes} bytes`,
            502,
            "CONTENT_ZIP_RANGE_TRUNCATED",
          ));
        });
      });
      lastError = null;
    } catch (error) {
      lastError = error?.name === "AbortError" ? timeoutError : error;
      controller.abort();
      body?.destroy?.();
      if (attempt < maximumAttempts && received < expectedBytes) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** (attempt - 1))));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (received !== expectedBytes) throw lastError || statusError(
    `R2 ZIP directory range was truncated (${received}/${expectedBytes} bytes)`,
    502,
    "CONTENT_ZIP_RANGE_TRUNCATED",
  );
  return Buffer.concat(chunks, received);
}

function metadataMatches(metadata, identity) {
  return Number(metadata?.version || 0) === CACHE_VERSION
    && clean(metadata?.object_key) === identity.object_key
    && Number(metadata?.size_bytes || 0) === identity.size_bytes
    && clean(metadata?.etag).replace(/^"|"$/g, "") === identity.etag
    && clean(metadata?.cache_key) === identity.cache_key
    && Number.isInteger(Number(metadata?.cached_start))
    && Number(metadata.cached_start) >= 0
    && Number(metadata?.cached_end) === identity.size_bytes
    && Number(metadata?.cached_bytes) === identity.size_bytes - Number(metadata.cached_start);
}

async function loadPersistentCache({ identity, metadataPath, dataPath, memoryMaximum }) {
  try {
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
    if (!metadataMatches(metadata, identity)) return null;
    const stat = await fs.promises.stat(dataPath);
    if (!stat.isFile() || stat.size !== Number(metadata.cached_bytes)) return null;
    const buffer = stat.size <= memoryMaximum
      ? await fs.promises.readFile(dataPath)
      : null;
    return {
      source: "persistent_hit",
      persistent: true,
      cacheKey: identity.cache_key,
      cachedStart: Number(metadata.cached_start),
      cachedEnd: Number(metadata.cached_end),
      cachedBytes: Number(metadata.cached_bytes),
      centralDirectoryOffset: Number(metadata.central_directory_offset),
      centralDirectoryBytes: Number(metadata.central_directory_bytes),
      dataPath,
      metadataPath,
      buffer,
    };
  } catch {
    return null;
  }
}

async function persistCache({ metadataPath, dataPath, buffer, metadata }) {
  const suffix = `${process.pid}-${crypto.randomUUID()}.tmp`;
  const dataTemp = `${dataPath}.${suffix}`;
  const metadataTemp = `${metadataPath}.${suffix}`;
  let dataCommitted = false;
  let metadataCommitted = false;
  await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
  try {
    await fs.promises.writeFile(dataTemp, buffer, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(dataTemp, dataPath);
    dataCommitted = true;
    await fs.promises.writeFile(metadataTemp, `${JSON.stringify(metadata)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.promises.rename(metadataTemp, metadataPath);
    metadataCommitted = true;
  } finally {
    await fs.promises.unlink(dataTemp).catch(() => {});
    await fs.promises.unlink(metadataTemp).catch(() => {});
    if (dataCommitted && !metadataCommitted) {
      await fs.promises.unlink(dataPath).catch(() => {});
    }
  }
}

async function locateCentralDirectory({
  source,
  fetchRange,
  config,
  onProgress,
}) {
  const tailBytes = Math.min(source.sizeBytes, EOCD_SEARCH_BYTES);
  const tailStart = source.sizeBytes - tailBytes;
  const tail = await readRangeBuffer({
    fetchRange,
    start: tailStart,
    endExclusive: source.sizeBytes,
    timeoutMs: config.range_timeout_ms,
    maximumBytes: config.cache_max_bytes,
    heartbeatMs: config.heartbeat_ms,
    onProgress,
    phase: "locating_zip_directory",
  });
  const eocdOffset = findLastSignature(tail, EOCD_SIGNATURE);
  if (eocdOffset < 0 || eocdOffset + 22 > tail.length) {
    throw statusError(
      "ZIP end-of-central-directory record was not found",
      400,
      "CONTENT_ZIP_DIRECTORY_INVALID",
    );
  }
  const eocdAbsolute = tailStart + eocdOffset;
  const directoryBytes32 = tail.readUInt32LE(eocdOffset + 12);
  const directoryOffset32 = tail.readUInt32LE(eocdOffset + 16);
  let centralDirectoryBytes = directoryBytes32;
  let centralDirectoryOffset = directoryOffset32;

  if (directoryBytes32 === 0xffffffff || directoryOffset32 === 0xffffffff) {
    const locatorAbsolute = eocdAbsolute - 20;
    let locator;
    if (locatorAbsolute >= tailStart && locatorAbsolute + 20 <= source.sizeBytes) {
      locator = tail.subarray(locatorAbsolute - tailStart, locatorAbsolute - tailStart + 20);
    } else {
      locator = await readRangeBuffer({
        fetchRange,
        start: locatorAbsolute,
        endExclusive: locatorAbsolute + 20,
        timeoutMs: config.range_timeout_ms,
        maximumBytes: config.cache_max_bytes,
        heartbeatMs: config.heartbeat_ms,
        onProgress,
        phase: "locating_zip64_directory",
      });
    }
    if (locator.length < 20 || locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
      throw statusError(
        "ZIP64 end-of-central-directory locator is missing",
        400,
        "CONTENT_ZIP_DIRECTORY_INVALID",
      );
    }
    const zip64Offset = safeUInt64(locator, 8, "directory offset");
    let zip64Record;
    if (zip64Offset >= tailStart && zip64Offset + 56 <= source.sizeBytes) {
      zip64Record = tail.subarray(zip64Offset - tailStart, zip64Offset - tailStart + 56);
    } else {
      zip64Record = await readRangeBuffer({
        fetchRange,
        start: zip64Offset,
        endExclusive: zip64Offset + 56,
        timeoutMs: config.range_timeout_ms,
        maximumBytes: config.cache_max_bytes,
        heartbeatMs: config.heartbeat_ms,
        onProgress,
        phase: "locating_zip64_directory",
      });
    }
    if (zip64Record.length < 56 || zip64Record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw statusError(
        "ZIP64 end-of-central-directory record is invalid",
        400,
        "CONTENT_ZIP_DIRECTORY_INVALID",
      );
    }
    centralDirectoryBytes = safeUInt64(zip64Record, 40, "central directory size");
    centralDirectoryOffset = safeUInt64(zip64Record, 48, "central directory start");
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (
    centralDirectoryOffset < 0
    || centralDirectoryBytes < 0
    || centralDirectoryEnd > eocdAbsolute
    || centralDirectoryEnd > source.sizeBytes
  ) {
    throw statusError(
      "ZIP central-directory bounds are invalid",
      400,
      "CONTENT_ZIP_DIRECTORY_INVALID",
    );
  }
  return {
    tail,
    tailStart,
    centralDirectoryOffset,
    centralDirectoryBytes,
  };
}

async function prepareUnshared({
  source,
  cacheKey,
  cacheDir,
  config,
  fetchRange,
  onProgress,
}) {
  const identity = sourceIdentity(source, cacheKey);
  const basename = cacheBasename(identity);
  const dataPath = path.join(cacheDir, `${basename}.bin`);
  const metadataPath = path.join(cacheDir, `${basename}.json`);
  const existing = await loadPersistentCache({
    identity,
    metadataPath,
    dataPath,
    memoryMaximum: config.cache_memory_max_bytes,
  });
  if (existing) {
    await report(onProgress, {
      phase: "zip_directory_cache_ready",
      directory_cache: existing.source,
      directory_cache_bytes: existing.cachedBytes,
      directory_cache_persistent: true,
      movement: true,
    });
    return existing;
  }

  await report(onProgress, {
    phase: "locating_zip_directory",
    directory_cache: "miss",
    bytes_loaded: 0,
    bytes_total: 0,
    movement: true,
  });
  const located = await locateCentralDirectory({
    source,
    fetchRange,
    config,
    onProgress,
  });
  const cachedStart = located.centralDirectoryOffset;
  const cachedEnd = source.sizeBytes;
  const cachedBytes = cachedEnd - cachedStart;
  if (cachedBytes > config.cache_max_bytes) {
    throw statusError(
      `ZIP directory recovery cache requires ${cachedBytes} bytes, above the ${config.cache_max_bytes}-byte safety limit`,
      413,
      "CONTENT_ZIP_DIRECTORY_TOO_LARGE",
    );
  }
  let buffer;
  if (cachedStart >= located.tailStart) {
    buffer = located.tail.subarray(cachedStart - located.tailStart);
  } else {
    buffer = await readRangeBuffer({
      fetchRange,
      start: cachedStart,
      endExclusive: cachedEnd,
      timeoutMs: config.range_timeout_ms,
      maximumBytes: config.cache_max_bytes,
      heartbeatMs: config.heartbeat_ms,
      onProgress,
      phase: "loading_zip_directory",
    });
  }
  if (
    located.centralDirectoryBytes > 0
    && (buffer.length < 4 || buffer.readUInt32LE(0) !== CENTRAL_DIRECTORY_SIGNATURE)
  ) {
    throw statusError(
      "ZIP central-directory cache does not begin with a valid entry",
      400,
      "CONTENT_ZIP_DIRECTORY_INVALID",
    );
  }

  const metadata = {
    version: CACHE_VERSION,
    ...identity,
    cached_start: cachedStart,
    cached_end: cachedEnd,
    cached_bytes: cachedBytes,
    central_directory_offset: located.centralDirectoryOffset,
    central_directory_bytes: located.centralDirectoryBytes,
    created_at: new Date().toISOString(),
  };
  let persistent = true;
  let persistenceError = "";
  try {
    await persistCache({
      metadataPath,
      dataPath,
      buffer,
      metadata,
    });
  } catch (error) {
    persistent = false;
    persistenceError = clean(error?.code || error?.message).slice(0, 160);
  }
  const result = {
    source: persistent ? "fresh_r2_persisted" : "fresh_r2_memory",
    persistent,
    cacheKey: identity.cache_key,
    cachedStart,
    cachedEnd,
    cachedBytes,
    centralDirectoryOffset: located.centralDirectoryOffset,
    centralDirectoryBytes: located.centralDirectoryBytes,
    dataPath: persistent ? dataPath : "",
    metadataPath: persistent ? metadataPath : "",
    buffer,
    ...(persistenceError ? { persistenceError } : {}),
  };
  await report(onProgress, {
    phase: "zip_directory_cache_ready",
    directory_cache: result.source,
    directory_cache_bytes: cachedBytes,
    directory_cache_persistent: persistent,
    ...(persistenceError ? { directory_cache_warning: persistenceError } : {}),
    movement: true,
  });
  return result;
}

export async function prepareR2ZipDirectoryCache({
  source,
  cacheKey = "",
  cacheDir,
  config = contentZipRecoveryConfig(),
  fetchRange,
  onProgress,
} = {}) {
  const identity = sourceIdentity(source, cacheKey);
  if (!identity.object_key || !identity.size_bytes) {
    throw statusError("A complete R2 ZIP source is required for directory caching", 400);
  }
  if (typeof fetchRange !== "function") {
    throw new TypeError("prepareR2ZipDirectoryCache fetchRange is required");
  }
  const resolvedCacheDir = clean(cacheDir) || config.cache_dir;
  const preparationKey = `${resolvedCacheDir}\u0000${cacheBasename(identity)}`;
  if (!preparations.has(preparationKey)) {
    const operation = prepareUnshared({
      source: {
        objectKey: identity.object_key,
        sizeBytes: identity.size_bytes,
        etag: identity.etag,
      },
      cacheKey: identity.cache_key,
      cacheDir: resolvedCacheDir,
      config,
      fetchRange,
      onProgress,
    }).finally(() => preparations.delete(preparationKey));
    preparations.set(preparationKey, operation);
  }
  return preparations.get(preparationKey);
}

export function readZipDirectoryCacheRange(cache, start, endExclusive) {
  if (
    !cache
    || !Number.isFinite(start)
    || !Number.isFinite(endExclusive)
    || start < cache.cachedStart
    || endExclusive > cache.cachedEnd
    || endExclusive < start
  ) {
    return null;
  }
  const relativeStart = start - cache.cachedStart;
  const relativeEnd = endExclusive - cache.cachedStart;
  if (cache.buffer) {
    return Readable.from([cache.buffer.subarray(relativeStart, relativeEnd)]);
  }
  if (!cache.dataPath) return null;
  if (relativeEnd === relativeStart) return Readable.from([]);
  return fs.createReadStream(cache.dataPath, {
    start: relativeStart,
    end: relativeEnd - 1,
  });
}

export function zipDirectoryCacheSummary(cache) {
  if (!cache) return {
    source: "unavailable",
    persistent: false,
    bytes: 0,
  };
  return {
    source: clean(cache.source) || "unknown",
    persistent: cache.persistent === true,
    bytes: Math.max(0, Number(cache.cachedBytes || 0)),
    central_directory_bytes: Math.max(0, Number(cache.centralDirectoryBytes || 0)),
    ...(cache.persistenceError ? { warning: clean(cache.persistenceError) } : {}),
  };
}
