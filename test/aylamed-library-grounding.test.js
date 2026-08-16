import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAylaLibraryGroundingIndex,
  searchAylaLibraryGrounding,
  summarizeAylaLibraryGrounding,
} from "../lib/aylamed-library-grounding.js";

function book(overrides = {}) {
  return {
    id: "step1-first-aid-cardio",
    type: "book",
    title: "Cardiac murmurs",
    examTrackId: "usmle_step_1",
    system: "Cardiovascular",
    topic: "Murmurs",
    bookTitle: "First Aid 2026",
    edition: "2026",
    pdfPageStart: 12,
    pdfPageEnd: 13,
    authorizationStatus: "licensed",
    verificationStatus: "admin_verified_structured_source",
    approved: true,
    status: "active",
    sourceLabelVisible: true,
    sourceLabel: "First Aid 2026",
    readerPages: [
      { pdfPage: 12, printedPage: 8, heading: "Systolic murmurs", text: "Aortic stenosis produces a systolic ejection murmur.", complete: true },
      { pdfPage: 13, printedPage: 9, heading: "Diastolic murmurs", text: "Aortic regurgitation produces a diastolic murmur.", complete: true },
    ],
    ...overrides,
  };
}

test("library grounding is exam-scoped and returns exact approved page references", () => {
  const resources = [book(), book({ id: "nclex-safety", examTrackId: "nclex", title: "Delegation", system: "Safety", topic: "Delegation", bookTitle: "NCLEX Review", readerPages: [{ pdfPage: 12, printedPage: 8, heading: "Delegation", text: "Delegate stable tasks within scope.", complete: true }, { pdfPage: 13, printedPage: 9, heading: "Supervision", text: "Supervise delegated care.", complete: true }] })];
  const index = buildAylaLibraryGroundingIndex({ resources, examTrack: "USMLE Step 1" });
  assert.equal(index.length, 2);
  assert.ok(index.every((row) => row.examTrackId === "usmle_step_1"));

  const results = searchAylaLibraryGrounding({ resources, examTrack: "usmle_step_1", query: "aortic stenosis", limit: 4 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].source, "AylaMed Exam Library");
  assert.equal(results[0].resource_id, "step1-first-aid-cardio");
  assert.equal(results[0].printed_page, "8");
  assert.match(results[0].exact_reference, /First Aid 2026/);
  assert.doesNotMatch(JSON.stringify(results), /NCLEX Review/);
});

test("unapproved, unauthorized and incomplete library rows never ground the tutor", () => {
  const resources = [
    book({ id: "approved" }),
    book({ id: "private", approved: false }),
    book({ id: "unlicensed", authorizationStatus: "unverified" }),
    book({ id: "incomplete", readerPages: [book().readerPages[0]] }),
  ];
  const results = searchAylaLibraryGrounding({ resources, examTrack: "usmle_step_1", query: "murmur", limit: 20 });
  assert.ok(results.length > 0);
  assert.ok(results.every((row) => row.resource_id === "approved"));
});

test("historical CRM IDs do not disqualify page content stored in AylaMed", () => {
  const results = searchAylaLibraryGrounding({
    resources: [book({ sourceDocumentId: "legacy-crm-document", sourceTrainingItemId: "legacy-crm-item" })],
    examTrack: "usmle_step_1",
    query: "aortic stenosis",
  });
  assert.ok(results.length >= 1);
  assert.ok(results.every((row) => row.source === "AylaMed Exam Library"));
  assert.ok(results.every((row) => row.resource_id === "step1-first-aid-cardio"));
});

test("grounding status reports resources, pages and books per exam", () => {
  const summary = summarizeAylaLibraryGrounding({ resources: [book(), book({ id: "nclex", examTrackId: "nclex", bookTitle: "NCLEX Review" })] });
  assert.equal(summary.eligible_items, 4);
  assert.equal(summary.eligible_documents, 2);
  assert.equal(summary.eligible_books, 2);
  assert.deepEqual(summary.per_exam.map((row) => row.exam_track_id), ["nclex", "usmle_step_1"]);
});
