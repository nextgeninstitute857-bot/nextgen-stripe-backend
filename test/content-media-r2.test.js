import test from "node:test";
import assert from "node:assert/strict";
import { contentMediaStatus, matchMediaReferences, safeMediaEntryName } from "../lib/content-media-r2.js";

test("R2 remains disabled until every private credential is configured", () => {
  assert.equal(contentMediaStatus({}).configured, false);
  assert.equal(contentMediaStatus({
    CLOUDFLARE_R2_ACCOUNT_ID: "account",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "access",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
  }).configured, false);
  assert.equal(contentMediaStatus({}).public_access, false);
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

test("an exact ZIP-relative path resolves duplicate basenames", () => {
  const report = matchMediaReferences([{ questionId: "q1", mediaRef: "chapter-a/diagram.png" }], [
    { originalName: "chapter-a/diagram.png", sha256: "a" },
    { originalName: "chapter-b/diagram.png", sha256: "b" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].asset.sha256, "a");
});
