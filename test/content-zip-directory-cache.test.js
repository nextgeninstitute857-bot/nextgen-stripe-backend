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
