import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  openContentZip,
  openContentZipEntry,
} from "../lib/content-zip-source.js";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(name, content) {
  const filename = Buffer.from(name);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  return {
    buffer: Buffer.concat([local, data, central, eocd]),
    dataStart: local.length,
    dataEnd: local.length + data.length,
  };
}

function buildVirtualZip64(entryCount, sizeBytes = 6_700_000_000) {
  const names = Array.from(
    { length: entryCount },
    (_, index) => `images/file-${String(index + 1).padStart(5, "0")}.png`,
  );
  const centralBytes = names.reduce(
    (total, name) => total + 46 + Buffer.byteLength(name),
    0,
  );
  const centralDirectory = Buffer.allocUnsafe(centralBytes);
  let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name);
    centralDirectory.writeUInt32LE(0x02014b50, offset);
    centralDirectory.writeUInt16LE(45, offset + 4);
    centralDirectory.writeUInt16LE(20, offset + 6);
    centralDirectory.writeUInt16LE(0, offset + 8);
    centralDirectory.writeUInt16LE(0, offset + 10);
    centralDirectory.writeUInt16LE(0, offset + 12);
    centralDirectory.writeUInt16LE(0, offset + 14);
    centralDirectory.writeUInt32LE(0, offset + 16);
    centralDirectory.writeUInt32LE(0, offset + 20);
    centralDirectory.writeUInt32LE(0, offset + 24);
    centralDirectory.writeUInt16LE(filename.length, offset + 28);
    centralDirectory.writeUInt16LE(0, offset + 30);
    centralDirectory.writeUInt16LE(0, offset + 32);
    centralDirectory.writeUInt16LE(0, offset + 34);
    centralDirectory.writeUInt16LE(0, offset + 36);
    centralDirectory.writeUInt32LE(0, offset + 38);
    centralDirectory.writeUInt32LE(0, offset + 42);
    filename.copy(centralDirectory, offset + 46);
    offset += 46 + filename.length;
  }
  const trailer = Buffer.alloc(56 + 20 + 22);
  const centralOffset = sizeBytes - centralBytes - trailer.length;
  const zip64Offset = centralOffset + centralBytes;
  trailer.writeUInt32LE(0x06064b50, 0);
  trailer.writeBigUInt64LE(44n, 4);
  trailer.writeUInt16LE(45, 12);
  trailer.writeUInt16LE(45, 14);
  trailer.writeUInt32LE(0, 16);
  trailer.writeUInt32LE(0, 20);
  trailer.writeBigUInt64LE(BigInt(entryCount), 24);
  trailer.writeBigUInt64LE(BigInt(entryCount), 32);
  trailer.writeBigUInt64LE(BigInt(centralBytes), 40);
  trailer.writeBigUInt64LE(BigInt(centralOffset), 48);
  trailer.writeUInt32LE(0x07064b50, 56);
  trailer.writeUInt32LE(0, 60);
  trailer.writeBigUInt64LE(BigInt(zip64Offset), 64);
  trailer.writeUInt32LE(1, 72);
  trailer.writeUInt32LE(0x06054b50, 76);
  trailer.writeUInt16LE(0, 80);
  trailer.writeUInt16LE(0, 82);
  trailer.writeUInt16LE(0xffff, 84);
  trailer.writeUInt16LE(0xffff, 86);
  trailer.writeUInt32LE(0xffffffff, 88);
  trailer.writeUInt32LE(0xffffffff, 92);
  trailer.writeUInt16LE(0, 96);

  const read = (start, endExclusive) => {
    const output = Buffer.alloc(endExclusive - start);
    const copySegment = (segment, segmentStart) => {
      const overlapStart = Math.max(start, segmentStart);
      const overlapEnd = Math.min(endExclusive, segmentStart + segment.length);
      if (overlapEnd <= overlapStart) return;
      segment.copy(
        output,
        overlapStart - start,
        overlapStart - segmentStart,
        overlapEnd - segmentStart,
      );
    };
    copySegment(centralDirectory, centralOffset);
    copySegment(trailer, zip64Offset);
    return output;
  };
  return {
    sizeBytes,
    centralBytes,
    read,
  };
}

async function countEntries(zip) {
  let count = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", () => {
      count += 1;
      zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return count;
}

test("35,000-entry R2 recovery uses a persistent bulk directory cache across restarts", async (t) => {
  const archive = buildVirtualZip64(35_000);
  const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ayla-zip-directory-"));
  t.after(() => fs.promises.rm(cacheDir, { recursive: true, force: true }));
  const source = {
    type: "r2",
    objectKey: "content-uploads/media-part-1.zip",
    sizeBytes: archive.sizeBytes,
    etag: "immutable-etag",
  };
  const ranges = [];
  const fetchRange = async ({ start, endExclusive }) => {
    ranges.push([start, endExclusive]);
    return Readable.from([archive.read(start, endExclusive)]);
  };

  const first = await openContentZip(source, {
    autoClose: false,
    directoryCacheKey: "media-part-1-sha256",
    directoryCacheDir: cacheDir,
    fetchRange,
  });
  assert.equal(await countEntries(first), 35_000);
  assert.equal(first.contentRecovery.directory_cache.source, "fresh_r2_persisted");
  assert.equal(first.contentRecovery.directory_cache.persistent, true);
  assert.ok(first.contentRecovery.directory_cache.bytes >= archive.centralBytes);
  assert.ok(ranges.length <= 2, `expected at most two bulk R2 reads, received ${ranges.length}`);
  first.close();

  let restartRangeReads = 0;
  const restarted = await openContentZip(source, {
    autoClose: false,
    directoryCacheKey: "media-part-1-sha256",
    directoryCacheDir: cacheDir,
    fetchRange: async () => {
      restartRangeReads += 1;
      throw new Error("persistent directory cache should avoid R2 reads");
    },
  });
  assert.equal(await countEntries(restarted), 35_000);
  assert.equal(restarted.contentRecovery.directory_cache.source, "persistent_hit");
  assert.equal(restartRangeReads, 0);
  restarted.close();
});

test("legacy directory caches are rebuilt instead of being reused", async (t) => {
  const archive = buildVirtualZip64(250);
  const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ayla-directory-version-"));
  t.after(() => fs.promises.rm(cacheDir, { recursive: true, force: true }));
  const source = {
    type: "r2",
    objectKey: "content-staging/versioned-directory.zip",
    sizeBytes: archive.sizeBytes,
    etag: "versioned-directory-etag",
  };
  const fetchRange = async ({ start, endExclusive }) => (
    Readable.from([archive.read(start, endExclusive)])
  );

  const first = await openContentZip(source, {
    autoClose: false,
    directoryCacheKey: "versioned-directory-fingerprint",
    directoryCacheDir: cacheDir,
    fetchRange,
  });
  assert.equal(await countEntries(first), 250);
  first.close();

  const metadataPath = (await fs.promises.readdir(cacheDir))
    .map((name) => path.join(cacheDir, name))
    .find((file) => file.endsWith(".json"));
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
  await fs.promises.writeFile(metadataPath, `${JSON.stringify({ ...metadata, version: 1 })}\n`);

  let rebuildRangeReads = 0;
  const rebuilt = await openContentZip(source, {
    autoClose: false,
    directoryCacheKey: "versioned-directory-fingerprint",
    directoryCacheDir: cacheDir,
    fetchRange: async (range) => {
      rebuildRangeReads += 1;
      return fetchRange(range);
    },
  });
  assert.equal(await countEntries(rebuilt), 250);
  assert.equal(rebuilt.contentRecovery.directory_cache.source, "fresh_r2_persisted");
  assert.ok(rebuildRangeReads > 0);
  rebuilt.close();
});

test("R2 directory recovery resumes after a mid-stream tail-range failure", async (t) => {
  const archive = buildVirtualZip64(250);
  const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ayla-directory-resume-"));
  t.after(() => fs.promises.rm(cacheDir, { recursive: true, force: true }));
  let injectedFailure = false;
  const zip = await openContentZip({
    type: "r2",
    objectKey: "content-staging/interrupted-directory.zip",
    sizeBytes: archive.sizeBytes,
    etag: "multipart-directory-etag",
  }, {
    autoClose: false,
    directoryCacheKey: "interrupted-directory-fingerprint",
    directoryCacheDir: cacheDir,
    fetchRange: async ({ start, endExclusive }) => {
      const selected = archive.read(start, endExclusive);
      if (!injectedFailure) {
        injectedFailure = true;
        return Readable.from((async function* interruptedDirectoryRange() {
          yield selected.subarray(0, 17);
          throw new Error("simulated R2 directory reset");
        })());
      }
      return Readable.from([selected]);
    },
  });
  assert.equal(await countEntries(zip), 250);
  assert.equal(injectedFailure, true);
  assert.equal(zip.contentRecovery.directory_cache.persistent, true);
  zip.close();
});

test("ZIP entry opening fails with a bounded, named timeout", async () => {
  const zip = {
    contentRecovery: { entry_open_timeout_ms: 10 },
    openReadStream() {},
  };
  await assert.rejects(
    () => openContentZipEntry(zip, { fileName: "images/stuck.png" }, { timeoutMs: 10 }),
    /ZIP entry open timed out after 10ms: images\/stuck\.png/,
  );
});

test("R2 random access resumes a ZIP entry after a mid-stream range failure", async (t) => {
  const expected = Buffer.from("private-qbank-json".repeat(256));
  const archive = buildStoredZip("questions.json", expected);
  const cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ayla-range-resume-"));
  t.after(() => fs.promises.rm(cacheDir, { recursive: true, force: true }));
  let injectedFailure = false;
  const source = {
    type: "r2",
    objectKey: "content-staging/private-qbank.zip",
    sizeBytes: archive.buffer.length,
    etag: "multipart-etag",
  };
  const zip = await openContentZip(source, {
    autoClose: false,
    directoryCacheKey: "private-qbank-fingerprint",
    directoryCacheDir: cacheDir,
    fetchRange: async ({ start, endExclusive }) => {
      const selected = archive.buffer.subarray(start, endExclusive);
      if (!injectedFailure && start >= archive.dataStart && start < archive.dataEnd) {
        injectedFailure = true;
        return Readable.from((async function* interruptedRange() {
          yield selected.subarray(0, 17);
          throw new Error("simulated R2 mid-stream reset");
        })());
      }
      return Readable.from([selected]);
    },
  });
  const received = await new Promise((resolve, reject) => {
    zip.once("entry", async (entry) => {
      try {
        const stream = await openContentZipEntry(zip, entry);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        resolve(Buffer.concat(chunks));
      } catch (error) {
        reject(error);
      }
    });
    zip.once("error", reject);
    zip.readEntry();
  });
  zip.close();
  assert.equal(injectedFailure, true);
  assert.deepEqual(received, expected);
});
