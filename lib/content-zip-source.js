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
    const maximumAttempts = 3;
    let activeBody = null;
    let activeController = null;
    let cancelled = false;
    let offset = start;

    const stopActiveRead = () => {
      activeController?.abort();
      activeBody?.destroy?.();
      activeBody = null;
      activeController = null;
    };
    output.once("close", () => {
      cancelled = true;
      stopActiveRead();
    });

    const readAttempt = async () => {
      activeController = new AbortController();
      const timeoutError = statusError(
        `R2 ZIP range read timed out after ${this.rangeTimeoutMs}ms`,
        504,
      );
      let settle;
      let timer = null;
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          activeController?.abort();
          activeBody?.destroy?.(timeoutError);
          settle?.(timeoutError);
        }, this.rangeTimeoutMs);
        timer.unref?.();
      };
      resetTimer();
      try {
        activeBody = await Promise.race([
          this.fetchRange({
            start: offset,
            endExclusive: end,
            signal: activeController.signal,
          }),
          new Promise((_, reject) => { settle = reject; }),
        ]);
        if (cancelled) return;
        const body = activeBody;
        await new Promise((resolve, reject) => {
          settle = reject;
          resetTimer();
          let finished = false;
          const finish = (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            body?.removeAllListeners?.("data");
            body?.removeAllListeners?.("end");
            body?.removeAllListeners?.("error");
            body?.removeAllListeners?.("aborted");
            body?.removeAllListeners?.("close");
            if (error) {
              body?.destroy?.();
              reject(error);
            } else resolve();
          };
          body.on("data", (chunk) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (offset + value.length > end) {
              finish(statusError("R2 ZIP range response exceeded the requested bounds", 502));
              return;
            }
            offset += value.length;
            resetTimer();
            if (!output.write(value)) {
              body.pause?.();
              output.once("drain", () => body.resume?.());
            }
          });
          body.once("end", () => finish(
            offset === end
              ? null
              : statusError(`R2 ZIP range was truncated at ${offset}/${end}`, 502),
          ));
          body.once("error", finish);
          body.once("aborted", () => finish(timeoutError));
          body.once("close", () => {
            if (offset < end) finish(statusError(`R2 ZIP range closed at ${offset}/${end}`, 502));
          });
        });
      } finally {
        clearTimeout(timer);
        activeBody = null;
        activeController = null;
      }
    };

    void (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= maximumAttempts && offset < end && !cancelled; attempt += 1) {
        try {
          await readAttempt();
          lastError = null;
        } catch (error) {
          lastError = error;
          stopActiveRead();
          if (attempt < maximumAttempts && !cancelled) {
            await new Promise((resolve) => {
              setTimeout(resolve, 200 * (2 ** (attempt - 1)));
            });
          }
        }
      }
      if (cancelled) return;
      if (offset === end) output.end();
      else output.destroy(lastError || statusError(`R2 ZIP range ended at ${offset}/${end}`, 502));
    })();
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

export async function openNamedContentZipEntry(value, entryName, {
  directoryCacheKey = "",
} = {}) {
  const expected = String(entryName || "").replace(/\\/g, "/");
  const zip = await openContentZip(value, {
    autoClose: false,
    directoryCacheKey,
  });
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
