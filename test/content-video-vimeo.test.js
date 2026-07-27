import test from "node:test";
import assert from "node:assert/strict";
import {
  contentVideoStatus,
  isVideoMediaRef,
  matchVideoReferences,
  matchVideoReferencesByVerifiedAliases,
  normalizeVerifiedVideoAliases,
  safeVideoEntryName,
} from "../lib/content-video-vimeo.js";

test("Vimeo remains disabled until an access token is configured", () => {
  assert.equal(contentVideoStatus({}).configured, false);
  assert.equal(contentVideoStatus({ VIMEO_ACCESS_TOKEN: " token " }).configured, true);
});

test("video references are classified without treating images as videos", () => {
  assert.equal(isVideoMediaRef("media/87311.mp4"), true);
  assert.equal(isVideoMediaRef("image/87311.png"), false);
  assert.equal(safeVideoEntryName("iMD/17407.mp4"), "iMD/17407.mp4");
  assert.equal(safeVideoEntryName("iMD/17407.mkv"), "iMD/17407.mkv");
  assert.equal(safeVideoEntryName("iMD/17407.wmv"), "iMD/17407.wmv");
  assert.equal(safeVideoEntryName("../17407.mp4"), null);
  assert.equal(safeVideoEntryName("iMD/17407.exe"), null);
});

test("video matching is deterministic and never guesses ambiguity", () => {
  const references = [{ questionId: "q1", studentQid: "NGQ-1", mediaRef: "media/87311.mp4" }];
  const one = matchVideoReferences(references, [{ originalName: "iMD/87311.mp4", sha256: "a" }]);
  assert.equal(one.matches.length, 1);
  const two = matchVideoReferences(references, [
    { originalName: "a/87311.mp4", sha256: "a" }, { originalName: "b/87311.mp4", sha256: "b" },
  ]);
  assert.equal(two.matches.length, 0);
  assert.equal(two.ambiguous.length, 1);
});

test("video matching uses contextual paths before duplicate basenames", () => {
  const report = matchVideoReferences([{
    questionId: "q1",
    mediaRef: "clip.mp4",
    matchPaths: ["exports/cardio/videos/clip.mp4"],
  }], [
    { originalName: "part-2/exports/cardio/videos/clip.mp4", sha256: "cardio" },
    { originalName: "part-2/exports/renal/videos/clip.mp4", sha256: "renal" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].video.sha256, "cardio");
});

test("video matching uses the question edition without guessing across packages", () => {
  const report = matchVideoReferences([{
    questionId: "q1",
    mediaRef: "17407.mp4",
    sourceSnapshot: "uworldSTEP1-2026-march_questions.json",
  }], [
    { originalName: "STEP1-2025-March/iMD/17407.mp4", sha256: "2025" },
    { originalName: "STEP1-2026-march/iMD/17407.mp4", sha256: "2026" },
  ]);
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].video.sha256, "2026");
  assert.equal(report.ambiguous.length, 0);
});

test("video fallback can prefer the newest uniquely ranked exact media reference", () => {
  const report = matchVideoReferences([{
    questionId: "q1",
    mediaRef: "17407.mp4",
    sourceSnapshot: "uworldSTEP1-2023_questions.json",
  }], [
    { originalName: "STEP1-2025-March/iMD/17407.mp4", sha256: "2025" },
    { originalName: "STEP1-2026-march/iMD/17407.mp4", sha256: "2026" },
  ], {
    candidatePriority: (video) =>
      video.originalName.includes("2026") ? 0 : 1,
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].video.sha256, "2026");
});

test("verified content aliases require evidence and match the newest unique video", () => {
  const aliases = normalizeVerifiedVideoAliases([
    {
      media_ref: "S1_aortic_stenosis.mov",
      video_name: "71364.mp4",
      evidence: "visual title frame",
    },
    {
      media_ref: "unsafe.mov",
      video_name: "../unsafe.mp4",
      evidence: "invalid traversal",
    },
  ]);
  assert.equal(aliases.length, 1);
  const report = matchVideoReferencesByVerifiedAliases([{
    questionId: "q1",
    mediaRef: "S1_aortic_stenosis.mov",
  }, {
    questionId: "q2",
    mediaRef: "S1_2109.mov",
  }], [
    {
      originalName: "STEP1-2025/71364.mp4",
      archiveFingerprint: "old",
    },
    {
      originalName: "STEP1-2026/71364.mp4",
      archiveFingerprint: "new",
    },
  ], aliases, {
    candidatePriority: (video) =>
      video.originalName.includes("2026") ? 0 : 1,
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].video.archiveFingerprint, "new");
  assert.equal(report.matches[0].matchMethod, "admin_verified_content_alias");
  assert.equal(report.missing.length, 1);
});

test("verified content aliases quarantine conflicting best-priority videos", () => {
  const report = matchVideoReferencesByVerifiedAliases([{
    questionId: "q1",
    mediaRef: "S1_S3.mov",
  }], [
    { originalName: "a/76843.mp4", archiveFingerprint: "a" },
    { originalName: "b/76843.mp4", archiveFingerprint: "b" },
  ], [{
    media_ref: "S1_S3.mov",
    video_name: "76843.mp4",
    evidence: "visual title frame",
  }]);
  assert.equal(report.matches.length, 0);
  assert.equal(report.ambiguous.length, 1);
});
