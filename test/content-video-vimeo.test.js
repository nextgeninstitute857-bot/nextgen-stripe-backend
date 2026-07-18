import test from "node:test";
import assert from "node:assert/strict";
import { contentVideoStatus, isVideoMediaRef, matchVideoReferences, safeVideoEntryName } from "../lib/content-video-vimeo.js";

test("Vimeo remains disabled until an access token is configured", () => {
  assert.equal(contentVideoStatus({}).configured, false);
  assert.equal(contentVideoStatus({ VIMEO_ACCESS_TOKEN: " token " }).configured, true);
});

test("video references are classified without treating images as videos", () => {
  assert.equal(isVideoMediaRef("media/87311.mp4"), true);
  assert.equal(isVideoMediaRef("image/87311.png"), false);
  assert.equal(safeVideoEntryName("iMD/17407.mp4"), "iMD/17407.mp4");
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
