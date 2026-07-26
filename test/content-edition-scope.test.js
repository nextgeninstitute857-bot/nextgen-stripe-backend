import test from "node:test";
import assert from "node:assert/strict";
import {
  contentPathEditions,
  contentPathMatchesEdition,
  contentReferenceMatchesEdition,
  filterContentAssetsByEdition,
  filterContentReferencesByEdition,
  normalizeContentEdition,
} from "../lib/content-edition-scope.js";

test("content edition scope accepts only explicit four-digit editions", () => {
  assert.equal(normalizeContentEdition("2026"), "2026");
  assert.equal(normalizeContentEdition(2026), "2026");
  assert.equal(normalizeContentEdition("26"), "");
  assert.equal(normalizeContentEdition("all"), "");
});

test("content edition scope reads exact years without matching adjacent digits", () => {
  assert.deepEqual(contentPathEditions("STEP1-2026-march/SIM1/media/17407.mp4"), ["2026"]);
  assert.equal(contentPathMatchesEdition("STEP1-2026-march/media/17407.mp4", "2026"), true);
  assert.equal(contentPathMatchesEdition("STEP1-2025-march/media/17407.mp4", "2026"), false);
  assert.equal(contentPathMatchesEdition("folder/120260/file.mp4", "2026"), false);
});

test("reference edition is determined by the selected source snapshot, not old aliases", () => {
  const selected2025 = {
    sourceSnapshot: "uworldSTEP1-2025-sept_questions.json",
    sourceSnapshotAliases: ["uworldstep1-2026-march"],
  };
  const selected2026 = {
    sourceSnapshot: "uworldSTEP1-2026-march_questions.json",
    sourceSnapshotAliases: ["uworldstep1-2025-sept"],
  };
  assert.equal(contentReferenceMatchesEdition(selected2025, "2026"), false);
  assert.equal(contentReferenceMatchesEdition(selected2026, "2026"), true);
});

test("reference and asset filters leave other editions untouched", () => {
  const references = [
    { mediaRef: "a.png", sourceSnapshot: "step1-2024.json" },
    { mediaRef: "b.png", sourceSnapshot: "step1-2025.json" },
    { mediaRef: "c.png", sourceSnapshot: "step1-2026.json" },
  ];
  const assets = [
    { originalName: "step1-2024/a.png" },
    { originalName: "step1-2025/b.png" },
    { originalName: "step1-2026/c.png" },
  ];
  assert.deepEqual(filterContentReferencesByEdition(references, "2026"), [references[2]]);
  assert.deepEqual(filterContentAssetsByEdition(assets, "2026"), [assets[2]]);
});
