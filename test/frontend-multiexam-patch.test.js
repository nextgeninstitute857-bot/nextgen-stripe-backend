import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { EXAM_EXPERIENCES, examExperience } from "../frontend-patches/src/config/examExperience.js";

test("frontend patch has one shared USMLE experience and four standalone exam experiences", () => {
  assert.deepEqual(Object.keys(EXAM_EXPERIENCES), ["usmle", "mccqe", "amc", "nclex", "plab"]);
  assert.deepEqual(examExperience("usmle").examTrackIds, ["usmle_step_1", "usmle_step_2_ck", "usmle_step_3"]);
  assert.deepEqual(examExperience("amc").examTrackIds, ["amc"]);
  assert.match(examExperience("amc").subheadline, /Australian clinical reasoning/);
  assert.equal(examExperience("nclex").tabs.diagnostic, "Clinical Judgment Diagnostic");
  assert.equal(examExperience("mccqe").tabs.qbank, "MCCQE QBank");
  assert.equal(examExperience("plab").tabs.roadmap, "PLAB Roadmap");
});

test("frontend patch includes landing and publication-control components", () => {
  const landing = fs.readFileSync(new URL("../frontend-patches/src/components/ExamLandingPage.jsx", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../frontend-patches/src/components/admin/ExamPublicationPanel.jsx", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../frontend-patches/src/lib/publicationControls.js", import.meta.url), "utf8");
  assert.match(landing, /data-exam-site/);
  assert.match(landing, /experience\.examLabels/);
  assert.match(panel, /Master publication switch/);
  assert.match(panel, /available_resources/);
  assert.match(panel, /follows exam default/);
  assert.match(panel, /progress, history and every saved resource setting/);
  assert.match(client, /publication-controls\/exams/);
  assert.match(client, /publication-controls\/resources/);
});
