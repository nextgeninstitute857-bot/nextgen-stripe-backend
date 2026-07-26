import test from "node:test";
import assert from "node:assert/strict";
import { contentMediaStatus, matchMediaReferences, safeMediaEntryName } from "../lib/content-media-r2.js";
import { contentR2Timeouts, signContentR2UploadPart } from "../lib/content-r2-storage.js";

test("R2 remains disabled until every private credential is configured", () => {
  assert.equal(contentMediaStatus({}).configured, false);
  assert.equal(contentMediaStatus({
    CLOUDFLARE_R2_ACCOUNT_ID: "account",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "access",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
  }).configured, false);
  assert.equal(contentMediaStatus({}).public_access, false);
});

test("R2 requests have bounded connection, idle, and total timeouts", () => {
  assert.deepEqual(contentR2Timeouts({}), {
    connection_ms: 10_000,
    socket_idle_ms: 120_000,
    request_ms: 300_000,
  });
  assert.deepEqual(contentR2Timeouts({
    NEXTGEN_CONTENT_R2_CONNECTION_TIMEOUT_MS: "2500",
    NEXTGEN_CONTENT_R2_SOCKET_TIMEOUT_MS: "45000",
    NEXTGEN_CONTENT_R2_REQUEST_TIMEOUT_MS: "90000",
  }), {
    connection_ms: 2500,
    socket_idle_ms: 45000,
    request_ms: 90000,
  });
});

test("R2 multipart presigning omits unsupported optional checksum parameters", async () => {
  const names = [
    "CLOUDFLARE_R2_ACCOUNT_ID",
    "CLOUDFLARE_R2_ACCESS_KEY_ID",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_R2_BUCKET",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    CLOUDFLARE_R2_ACCOUNT_ID: "test-account",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "test-access-key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "test-secret-key",
    CLOUDFLARE_R2_BUCKET: "test-bucket",
  });

  try {
    const signed = new URL(await signContentR2UploadPart({
      objectKey: "content-staging/test/archive.zip",
      uploadId: "test-upload-id",
      partNumber: 1,
    }));
    assert.equal(signed.searchParams.has("x-amz-checksum-crc32"), false);
    assert.equal(signed.searchParams.has("x-amz-sdk-checksum-algorithm"), false);
    assert.equal(signed.searchParams.get("partNumber"), "1");
    assert.equal(signed.searchParams.get("uploadId"), "test-upload-id");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("media ZIP entry validation accepts image/audio and rejects unsafe or unsupported files", () => {
  assert.equal(safeMediaEntryName("images/U612.jpg.png"), "images/U612.jpg.png");
  assert.equal(safeMediaEntryName("heart-sounds/12360.mp3"), "heart-sounds/12360.mp3");
  assert.equal(safeMediaEntryName("../private.png"), null);
  assert.equal(safeMediaEntryName("/absolute/private.png"), null);
  assert.equal(safeMediaEntryName("C:\\private.png"), null);
  assert.equal(safeMediaEntryName("active.svg"), null);
  assert.equal(safeMediaEntryName("questions.json"), null);
});

test("media matching is deterministic and reports missing and unreferenced files", () => {
  const report = matchMediaReferences([
    { questionId: "q1", studentQid: "NGQ-00000001", mediaRef: "U612.jpg" },
    { questionId: "q2", studentQid: "NGQ-00000002", mediaRef: "missing.png" },
  ], [
    { originalName: "images/U612.jpg.png", sha256: "sha-a" },
    { originalName: "images/unused.png", sha256: "sha-b" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "sha-a");
  assert.equal(report.missing.length, 1);
  assert.deepEqual(report.unreferenced.map((item) => item.sha256), ["sha-b"]);
});

test("ambiguous filename matches are quarantined rather than guessed", () => {
  const report = matchMediaReferences([{ questionId: "q1", mediaRef: "diagram.png" }], [
    { originalName: "a/diagram.png", sha256: "sha-a" },
    { originalName: "b/diagram.png", sha256: "sha-b" },
  ]);
  assert.equal(report.matches.length, 0);
  assert.equal(report.ambiguous.length, 1);
});

test("an exact media filename wins before high-resolution fallback aliases", () => {
  const report = matchMediaReferences([{ questionId: "q1", mediaRef: "L1436.jpg" }], [
    { originalName: "L1436.jpg", sha256: "low" },
    { originalName: "highresdefault_L1436.jpg", sha256: "high" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "low");
});

test("the canonical question edition resolves duplicate filenames across media packages", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "L26809.jpg",
    sourceSnapshot: "uworldSTEP1-2026-march_questions.json",
  }], [
    { originalName: "STEP1-2025-March/L26809.jpg", sha256: "2025" },
    { originalName: "uworldSTEP1-2026-march/L26809.jpg", sha256: "2026" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "2026");
  assert.equal(report.ambiguous.length, 0);
});

test("an exact filename still wins over high-resolution aliases inside the selected edition", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "L1436.jpg",
    sourceSnapshot: "uworldSTEP1-2026-march_questions.json",
  }], [
    { originalName: "STEP1-2025-March/L1436.jpg", sha256: "old" },
    { originalName: "STEP1-2026-march/highresdefault_L1436.jpg", sha256: "high" },
    { originalName: "STEP1-2026-march/L1436.jpg", sha256: "exact" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "exact");
});

test("a unique source alias edition repairs a reference absent from its canonical snapshot", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "L26361.jpg",
    sourceSnapshot: "uworldSTEP1-2023_questions.json",
    sourceSnapshotAliases: ["uworldSTEP1-2025-March"],
  }], [
    { originalName: "STEP1-2025-March/L26361.jpg", sha256: "alias-edition" },
    { originalName: "STEP1-2026-march/L26361.jpg", sha256: "other-edition" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "alias-edition");
});

test("multiple different assets in an alias edition remain quarantined", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "L26361.jpg",
    sourceSnapshot: "uworldSTEP1-2023_questions.json",
    sourceSnapshotAliases: ["uworldSTEP1-2025-March"],
  }], [
    { originalName: "package-a/STEP1-2025-March/L26361.jpg", sha256: "a" },
    { originalName: "package-b/STEP1-2025-March/L26361.jpg", sha256: "b" },
    { originalName: "STEP1-2026-march/L26361.jpg", sha256: "other-edition" },
  ]);
  assert.equal(report.matches.length, 0);
  assert.equal(report.ambiguous.length, 1);
  assert.deepEqual(report.ambiguous[0].candidates, [
    "package-a/STEP1-2025-March/L26361.jpg",
    "package-b/STEP1-2025-March/L26361.jpg",
  ]);
});

test("an exact ZIP-relative path resolves duplicate basenames", () => {
  const report = matchMediaReferences([{ questionId: "q1", mediaRef: "chapter-a/diagram.png" }], [
    { originalName: "chapter-a/diagram.png", sha256: "a" },
    { originalName: "chapter-b/diagram.png", sha256: "b" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "a");
});

test("a contextual source path repairs an old basename-only media reference", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "diagram.png",
    matchPaths: [
      "exports/cardio/images/diagram.png",
      "images/diagram.png",
    ],
  }], [
    { originalName: "package/exports/cardio/images/diagram.png", sha256: "cardio" },
    { originalName: "package/exports/renal/images/diagram.png", sha256: "renal" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "cardio");
  assert.equal(report.ambiguous.length, 0);
});

test("contextual matching still quarantines a genuinely ambiguous path", () => {
  const report = matchMediaReferences([{
    questionId: "q1",
    mediaRef: "diagram.png",
    matchPaths: ["images/diagram.png"],
  }], [
    { originalName: "package-a/images/diagram.png", sha256: "a" },
    { originalName: "package-b/images/diagram.png", sha256: "b" },
  ]);
  assert.equal(report.matches.length, 0);
  assert.equal(report.ambiguous.length, 1);
});
