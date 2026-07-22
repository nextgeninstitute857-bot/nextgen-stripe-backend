import fs from "node:fs";
import { PassThrough } from "node:stream";
import yauzl from "yauzl";
import { getContentR2ObjectStream } from "./content-r2-storage.js";

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
  constructor(source) {
    super();
    this.source = source;
  }

  _readStreamForRange(start, end) {
    const output = new PassThrough();
    getContentR2ObjectStream(this.source.objectKey, { start, endExclusive: end })
      .then((body) => {
        body.on("error", (error) => output.destroy(error));
        body.pipe(output);
      })
      .catch((error) => output.destroy(error));
    return output;
  }
}

export function openContentZip(value, { autoClose = true } = {}) {
  const source = normalizeContentZipSource(value);
  if (source.type === "local") {
    return new Promise((resolve, reject) => yauzl.open(source.file, {
      lazyEntries: true, autoClose, decodeStrings: true, validateEntrySizes: true,
    }, (error, zip) => error ? reject(error) : resolve(zip)));
  }
  const reader = new R2RandomAccessReader(source);
  return new Promise((resolve, reject) => yauzl.fromRandomAccessReader(reader, source.sizeBytes, {
    lazyEntries: true, autoClose, decodeStrings: true, validateEntrySizes: true,
  }, (error, zip) => error ? reject(error) : resolve(zip)));
}

export function openContentZipEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
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
