import test from "node:test";
import assert from "node:assert/strict";
import { firstAidStep1ChapterSystem } from "../lib/aylamed-library.js";

const step1 = (pdfPage) => firstAidStep1ChapterSystem({
  bookTitle: "First Aid for the USMLE Step 1",
  examTrackId: "usmle_step_1",
  pdfPage,
});

test("First Aid Step 1 pages get their chapter from the page number", () => {
  assert.equal(step1(98), "Biochemistry"); // Electron transport chain
  assert.equal(step1(128), "Immunology"); // Lymph node
  assert.equal(step1(307), "Microbiology"); // Daptomycin
  assert.equal(step1(510), "Cardiovascular"); // Evolution of myocardial infarction
  assert.equal(step1(961), "Neurology"); // Barbiturates
  assert.equal(step1(1199), "Reproductive"); // Hormone replacement therapy
  assert.equal(step1(1263), "Respiratory"); // Lung cancer
});

test("other books, other exams and missing pages keep their stored subject", () => {
  assert.equal(firstAidStep1ChapterSystem({ bookTitle: "Fundamentals of Pathology", examTrackId: "usmle_step_1", pdfPage: 98 }), "");
  assert.equal(firstAidStep1ChapterSystem({ bookTitle: "First Aid for the USMLE Step 1", examTrackId: "usmle_step_2_ck", pdfPage: 98 }), "");
  assert.equal(step1(null), "");
});
