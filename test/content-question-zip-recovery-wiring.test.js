import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const zipImport = fs.readFileSync(
  new URL("../lib/content-zip-import.js", import.meta.url),
  "utf8",
);
const server = fs.readFileSync(
  new URL("../server.js", import.meta.url),
  "utf8",
);

test("question ZIP inventory accepts and forwards an R2 directory cache key", () => {
  assert.match(
    zipImport,
    /extractSafeZipInventory\(zipFile, jobId, dataDir, \{\s*directoryCacheKey = "",\s*onDirectoryCacheProgress,/,
  );
  assert.match(
    zipImport,
    /openContentZip\(zipFile, \{\s*directoryCacheKey,\s*onDirectoryCacheProgress,/,
  );
});

test("question preview and draft import reuse the fingerprinted R2 directory cache", () => {
  assert.match(
    server,
    /return fingerprint \? `\$\{fingerprint\}:questions` : "";/,
  );
  assert.equal(
    (server.match(/directoryCacheKey: ngQuestionZipDirectoryCacheKey\(/g) || []).length,
    2,
  );
  assert.equal(
    (server.match(/onDirectoryCacheProgress: ngQuestionZipRecoveryHeartbeat\(queueContext\)/g) || []).length,
    2,
  );
  assert.match(
    server,
    /const domainJob = await getContentImportJob\(jobId\);[\s\S]*directoryCacheKey: ngQuestionZipDirectoryCacheKey\(upload, domainJob \|\| \{\}\),/,
  );
  assert.match(server, /sha256: upload\.sha256 \|\| null,/);
  assert.match(server, /sha256: payload\.sha256 \|\| null,/);
});

test("question ZIP directory recovery reports movement without changing the job stage", () => {
  assert.match(
    server,
    /queueContext\.heartbeat\(\{\s*stage: "extracting_zip",\s*zip_recovery: progress,/,
  );
});
