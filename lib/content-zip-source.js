import fs from "node:fs";
import { PassThrough } from "node:stream";
import yauzl from "yauzl";
import { getContentR2ObjectStream } from "./content-r2-storage.js";
import {
  contentZipRecoveryConfig,
  prepareR2ZipDirectoryCache,
  readZipDirectoryCacheRange,
  zipDirectoryCacheSummary,
} from "./content-zip-directory-cache.js";

function statusError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeContentZipSource(value) {
  if (typeof value === "string" && value.trim()) return { type: "local", file: value.trim() };
  if (value?.type === "local" && value.file) return { type: "local", file: String(value.file) };
  if (value?.type === "r2" && value.objectKey && Number(value.sizeBytes) > 0) {
    return {
      type: "r2",
      objectKey: String(value.objectKey),
      sizeBytes: Number(value.sizeBytes),
      etag: String(value.etag || ""),
    };
  }
  throw statusError("A valid local or R2 ZIP source is required", 400);
}

class R2RandomAccessReader extends yauzl.RandomAccessReader {
  constructor(source, {
    directoryCache = null,
    rangeTimeoutMs,
    fetchRange,
  } = {}) {
    super();
    this.source = source;
    this.directoryCache = directoryCache;
    this.rangeTimeoutMs = Math.max(1_000, Number(rangeTimeoutMs || 45_000));
    this.fetchRange = typeof fetchRange === "function"
      ? fetchRange
      : ({ start, endExclusive, signal }) => getContentR2ObjectStream(
        this.source.objectKey,
        { start, endExclusive, signal },
      );
  }

  _readStreamForRange(start, end) {
    const cached = readZipDirectoryCacheRange(this.directoryCache, start, end);
    if (cached) return cached;
    const output = new PassThrough();
    const controller = new AbortController();
    const timeoutError = statusError(
      `R2 ZIP range read timed out after ${this.rangeTimeoutMs}ms`,
      504,
    );
    const timer = setTimeout(() => {
      controller.abort();
      output.destroy(timeoutError);
    }, this.rangeTimeoutMs);
    timer.unref?.();
    this.fetchRange({ start, endExclusive: end, signal: controller.signal })
      .then((body) => {
        body.on("error", (error) => {
          clearTimeout(timer);
          output.destroy(error);
        });
        body.once("data", () => clearTimeout(timer));
        body.on("end", () => clearTimeout(timer));
        body.pipe(output);
      })
      .catch((error) => {
        clearTimeout(timer);
        output.destroy(controller.signal.aborted ? timeoutError : error);
      });
    return output;
  }
}

function openTimeoutPromise(executor, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(statusError(`${label} timed out after ${timeoutMs}ms`, 504));
    }, timeoutMs);
    timer.unref?.();
    executor((error, value) => {
      if (settled) {
        value?.close?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export async function openContentZip(value, {
  autoClose = true,
  directoryCacheKey = "",
  directoryCacheDir,
  onDirectoryCacheProgress,
  rangeTimeoutMs,
  entryOpenTimeoutMs,
  recoveryConfig = contentZipRecoveryConfig(),
  fetchRange,
} = {}) {
  const source = normalizeContentZipSource(value);
  const resolvedRangeTimeoutMs = Math.max(
    1_000,
    Number(rangeTimeoutMs || recoveryConfig.range_timeout_ms),
  );
  const resolvedEntryOpenTimeoutMs = Math.max(
    1_000,
    Number(entryOpenTimeoutMs || recoveryConfig.entry_open_timeout_ms),
  );
  if (source.type === "local") {
    const zip = await openTimeoutPromise((done) => yauzl.open(source.file, {
      lazyEntries: true, autoClose, decodeStrings: true, validateEntrySizes: true,
    }, done), resolvedRangeTimeoutMs, "ZIP open");
    Object.defineProperty(zip, "contentRecovery", {
      value: {
        directory_cache: zipDirectoryCacheSummary(null),
        entry_open_timeout_ms: resolvedEntryOpenTimeoutMs,
      },
      enumerable: false,
    });
    return zip;
  }
  const resolvedFetchRange = typeof fetchRange === "function"
    ? fetchRange
    : ({ start, endExclusive, signal }) => getContentR2ObjectStream(
      source.objectKey,
      { start, endExclusive, signal },
    );
  const directoryCache = String(directoryCacheKey || "").trim()
    ? await prepareR2ZipDirectoryCache({
      source,
      cacheKey: directoryCacheKey,
      cacheDir: directoryCacheDir,
      config: {
        ...recoveryConfig,
        range_timeout_ms: resolvedRangeTimeoutMs,
      },
      fetchRange: resolvedFetchRange,
      onProgress: onDirectoryCacheProgress,
    })
    : null;
  const reader = new R2RandomAccessReader(source, {
    directoryCache,
    rangeTimeoutMs: resolvedRangeTimeoutMs,
    fetchRange: resolvedFetchRange,
  });
  const zip = await openTimeoutPromise((done) => yauzl.fromRandomAccessReader(reader, source.sizeBytes, {
    lazyEntries: true, autoClose, decodeStrings: true, validateEntrySizes: true,
  }, done), resolvedRangeTimeoutMs, "R2 ZIP open");
  Object.defineProperty(zip, "contentRecovery", {
    value: {
      directory_cache: zipDirectoryCacheSummary(directoryCache),
      entry_open_timeout_ms: resolvedEntryOpenTimeoutMs,
    },
    enumerable: false,
  });
  return zip;
}

export function openContentZipEntry(zip, entry, {
  timeoutMs = zip?.contentRecovery?.entry_open_timeout_ms
    || contentZipRecoveryConfig().entry_open_timeout_ms,
} = {}) {
  const safeTimeoutMs = Math.max(1, Number(timeoutMs || 45_000));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(statusError(
        `ZIP entry open timed out after ${safeTimeoutMs}ms: ${String(entry?.fileName || "unknown entry")}`,
        504,
      ));
    }, safeTimeoutMs);
    timer.unref?.();
    zip.openReadStream(entry, (error, stream) => {
      if (settled) {
        stream?.destroy?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

export async function openNamedContentZipEntry(value, entryName) {
  const expected = String(entryName || "").replace(/\\/g, "/");
  const zip = await openContentZip(value, { autoClose: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const close = () => { try { zip.close(); } catch { /* Already closed. */ } };
    zip.on("entry", async (entry) => {
      try {
        if (String(entry.fileName || "").replace(/\\/g, "/") !== expected) {
          zip.readEntry();
          return;
        }
        const stream = await openContentZipEntry(zip, entry);
        settled = true;
        const finish = () => close();
        stream.once("end", finish);
        stream.once("error", finish);
        resolve(stream);
      } catch (error) {
        close();
        reject(error);
      }
    });
    zip.on("end", () => {
      if (!settled) {
        close();
        reject(statusError(`ZIP entry not found: ${expected}`, 404));
      }
    });
    zip.on("error", (error) => { close(); reject(error); });
    zip.readEntry();
  });
}

export async function contentZipSourceExists(value) {
  const source = normalizeContentZipSource(value);
  if (source.type === "r2") return true;
  return fs.promises.access(source.file).then(() => true).catch(() => false);
}
