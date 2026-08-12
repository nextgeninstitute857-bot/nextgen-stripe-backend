import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaLibraryAssignmentProgress,
  buildAylaLibraryCatalog,
  buildAylaLibraryPage,
  buildAylaLibraryReader,
  combineAylaLibraryProgressRows,
  findAylaLibraryPage,
  hydrateAylaLibraryResourceFromCrm,
  mergeAylaLibraryProgress,
  mergeAylaLibraryProgressCollection,
  normalizeAylaLibraryResource,
  sanitizeAylaLibraryResource,
  searchAylaLibraryPages,
  selectAylaRoadmapReading,
} from "../lib/aylamed-library.js";

function reading(overrides = {}) {
  return {
    id: "reading-1",
    type: "book",
    title: "Cardiac murmurs",
    description: "Exact approved reading",
    examTrackId: "usmle_step_1",
    system: "Cardiovascular",
    topic: "Murmurs",
    bookTitle: "First Aid",
    edition: "2026",
    pdfPageStart: 12,
    pdfPageEnd: 13,
    printedPageStart: 8,
    printedPageEnd: 9,
    authorizationStatus: "licensed",
    verificationStatus: "approved_ai_training_center",
    approved: true,
    status: "active",
    sourceLabelVisible: true,
    sourceLabel: "First Aid 2026",
    readerPages: [
      { pdfPage: 12, printedPage: 8, text: "Approved page twelve.", blockIndex: 1, complete: true },
      { pdfPage: 13, printedPage: 9, text: "Approved page thirteen.", blockIndex: 2, complete: true },
    ],
    ...overrides,
  };
}

test("Library accepts only approved, exact, exam-matched reading pages", () => {
  const normalized = normalizeAylaLibraryResource(reading(), { examTrack: "USMLE Step 1" });
  assert.equal(normalized.id, "reading-1");
  assert.equal(normalized.readerReady, true);
  assert.equal(normalized.readerPageCount, 2);
  assert.equal(normalized.readerFirstPageKey, "pdf:12");
  assert.equal(normalized.pageRange, "8–9");
  assert.equal(normalizeAylaLibraryResource(normalized, { examTrack: "usmle_step_1" }).readerPageCount, 2);

  assert.equal(normalizeAylaLibraryResource(reading(), { examTrack: "nclex" }), null);
  assert.equal(normalizeAylaLibraryResource(reading(), { examTrack: "unsupported exam" }), null);
  assert.equal(normalizeAylaLibraryResource(reading({ authorizationStatus: "pending_review" })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ verificationStatus: "needs_review" })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ verificationStatus: "unverified" })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ verificationStatus: "not_approved" })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ status: "disabled" })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ readerPages: [reading().readerPages[0]] })), null);
  assert.equal(normalizeAylaLibraryResource(reading({
    readerPages: [
      { pdfPage: 12, printedPage: 8, text: "a".repeat(30001), blockIndex: 1 },
      { pdfPage: 12, printedPage: 8, text: "b".repeat(30001), blockIndex: 2 },
      reading().readerPages[1],
    ],
  })), null);
  assert.equal(normalizeAylaLibraryResource(reading({
    pdfPageStart: null,
    pdfPageEnd: null,
    printedPageStart: 8,
    printedPageEnd: 10,
    readerPages: [
      { printedPage: 8, text: "Page eight." },
      { printedPage: 10, text: "Page ten." },
    ],
  })), null);
  assert.equal(normalizeAylaLibraryResource(reading({ approved: false })), null);
});

test("CRM page blocks are delivered only when the document and every page block remain approved", () => {
  const resource = reading({
    readerPages: undefined,
    sourceDocumentId: "doc-1",
    sourceTrainingItemId: "item-1",
  });
  const documents = [{
    id: "doc-1",
    title: "First Aid",
    provider: "Authorized publisher",
    authorization_status: "licensed",
    approval_status: "approved",
    source_label_visible: true,
    source_label: "First Aid 2026",
    source_blocks: [
      { index: 1, pdf_page_start: 12, pdf_page_end: 12, status: "processed", text: "Approved CRM page twelve." },
      { index: 2, pdf_page_start: 13, pdf_page_end: 13, status: "processed", text: "Approved CRM page thirteen." },
    ],
  }];
  const approvedItems = [
    { id: "item-1", document_id: "doc-1", source_block_index: 1, active: true, approval_status: "approved" },
    { id: "item-2", document_id: "doc-1", source_block_index: 2, active: true, approval_status: "approved" },
  ];
  const hydrated = hydrateAylaLibraryResourceFromCrm({ documents, items: approvedItems, resource });
  const normalized = normalizeAylaLibraryResource(hydrated);
  assert.equal(normalized.readerPageCount, 2);
  assert.equal(normalized.readerPages[0].text, "Approved CRM page twelve.");
  assert.equal(normalized.sourceLabel, "First Aid 2026");

  const partlyApproved = hydrateAylaLibraryResourceFromCrm({ documents, items: [approvedItems[0], { ...approvedItems[1], active: false }], resource });
  assert.equal(normalizeAylaLibraryResource(partlyApproved), null);
  assert.equal(hydrateAylaLibraryResourceFromCrm({ documents: [{ ...documents[0], authorization_status: "revoked" }], items: approvedItems, resource }), null);

  const hidden = hydrateAylaLibraryResourceFromCrm({
    documents: [{ ...documents[0], source_label_visible: false }],
    items: approvedItems,
    resource,
  });
  assert.equal(normalizeAylaLibraryResource(hidden).sourceLabel, null);
});

test("page-turn reader returns one page with exact previous and next navigation", () => {
  const resource = normalizeAylaLibraryResource(reading());
  const reader = buildAylaLibraryReader(resource, { studentId: "student 1" });
  assert.equal(reader.pages.length, 2);
  assert.equal("content" in reader.pages[0], false);
  assert.equal(reader.navigation.continuous_pdf_scroll, false);
  assert.equal(reader.pages[0].page_path, "/api/ayla/students/student%201/library/resources/reading-1/pages/pdf-12");
  const assignedReader = buildAylaLibraryReader(resource, { studentId: "student 1", assignment: { id: "assignment 1" } });
  assert.equal(assignedReader.pages[0].page_path, "/api/ayla/students/student%201/library/resources/reading-1/pages/pdf-12?assignment_id=assignment%201");

  const first = buildAylaLibraryPage(resource, "pdf-12", { studentId: "student 1" });
  assert.equal(first.page.content, "Approved page twelve.");
  assert.equal(first.navigation.previous, null);
  assert.equal(first.navigation.next.pdf_page, 13);
  assert.equal(first.navigation.at_start, true);
  assert.equal(first.navigation.at_end, false);

  const second = buildAylaLibraryPage(resource, "pdf:13", { studentId: "student 1" });
  assert.equal(second.page.printed_page, "9");
  assert.equal(second.navigation.previous.pdf_page, 12);
  assert.equal(second.navigation.next, null);
  assert.equal(findAylaLibraryPage(resource, "pdf-999"), null);
});

test("inside-book search returns bounded snippets and page keys without whole-page payloads", () => {
  const resource = normalizeAylaLibraryResource(reading({
    coverImageUrl: "https://cdn.example.com/first-aid-cover.jpg",
    readerPages: [
      {
        pdfPage: 12,
        printedPage: 8,
        heading: "Systolic murmurs",
        text: "Aortic stenosis produces a crescendo-decrescendo systolic murmur.",
        complete: true,
      },
      {
        pdfPage: 13,
        printedPage: 9,
        heading: "Diastolic murmurs",
        text: "Aortic regurgitation produces an early diastolic decrescendo murmur.",
        complete: true,
      },
    ],
  }));
  const results = searchAylaLibraryPages(resource, "aortic murmur", {
    studentId: "student 1",
    limit: 1,
  });
  assert.equal(results.total, 2);
  assert.equal(results.results.length, 1);
  assert.equal(results.results[0].page_key, "pdf:12");
  assert.equal(results.results[0].book_page, 1);
  assert.match(results.results[0].snippet, /Aortic stenosis/i);
  assert.equal("content" in results.results[0], false);
  assert.equal("text" in results.results[0], false);
  assert.equal(
    results.results[0].page_path,
    "/api/ayla/students/student%201/library/resources/reading-1/pages/pdf-12",
  );
  assert.equal(
    sanitizeAylaLibraryResource(resource).cover_image_url,
    "https://cdn.example.com/first-aid-cover.jpg",
  );
  assert.equal(
    normalizeAylaLibraryResource(reading({ coverImageUrl: "javascript:alert(1)" })).coverImageUrl,
    null,
  );
});

test("student output hides raw source locations and obeys the admin source-label control", () => {
  const visible = sanitizeAylaLibraryResource(normalizeAylaLibraryResource(reading({ sourceUrl: "https://private.example/book.pdf" })), { studentId: "s1" });
  assert.equal(visible.source_label, "First Aid 2026");
  assert.equal("sourceUrl" in visible, false);
  assert.equal("source_url" in visible, false);
  assert.equal(visible.reader.mode, "page_turn");

  const hidden = sanitizeAylaLibraryResource(normalizeAylaLibraryResource(reading({
    id: "internal-notes",
    title: "Internal notes — Cardiac murmurs",
    description: "Read Internal notes before the next review.",
    bookTitle: "Internal notes",
    pageRange: "Internal notes pages 8-9",
    readerPages: reading().readerPages.map((page) => ({ ...page, heading: `Internal notes ${page.printedPage}` })),
    sourceLabelVisible: false,
    sourceLabel: "Hidden source",
  })), { studentId: "s1" });
  assert.equal(hidden.source_label, null);
  assert.equal(hidden.book_title, "AylaMed Reading");
  assert.equal(hidden.edition, "");
  assert.equal(hidden.title, "Cardiac murmurs");
  assert.equal(hidden.description, "Read before the next review.");
  assert.equal(hidden.page_range, "pages 8 9");
  assert.doesNotMatch(JSON.stringify(hidden), /Internal notes|Hidden source/i);
  const hiddenReader = buildAylaLibraryReader(normalizeAylaLibraryResource(reading({
    id: "internal-reader",
    bookTitle: "Internal notes",
    sourceLabelVisible: false,
    sourceLabel: "Hidden source",
    readerPages: reading().readerPages.map((page) => ({ ...page, heading: `Internal notes ${page.printedPage}` })),
  })));
  assert.doesNotMatch(JSON.stringify(hiddenReader.pages), /Internal notes|Hidden source/i);
});

test("Library catalog groups books, filters within one exam, and exposes resume state", () => {
  const renal = reading({
    id: "reading-2",
    title: "Renal clearance",
    description: "Internal renal notes clearance guide",
    bookTitle: "Internal renal notes",
    system: "Renal",
    topic: "Internal renal notes — Clearance",
    sourceLabelVisible: false,
    pdfPageStart: 20,
    pdfPageEnd: 20,
    printedPageStart: 14,
    printedPageEnd: 14,
    readerPages: [{ pdfPage: 20, printedPage: 14, text: "Renal page.", complete: true }],
  });
  const catalog = buildAylaLibraryCatalog({
    examTrack: "usmle_step_1",
    studentId: "s1",
    resources: [reading(), renal, reading({ id: "nclex", examTrackId: "nclex" })],
    progressRows: [{ studentId: "s1", resourceId: "reading-2", readPageKeys: [], progressPercent: 40, updatedAt: "2026-07-19T10:00:00.000Z" }],
    filters: { system: "Renal", search: "clearance" },
  });
  assert.equal(catalog.exam_track_id, "usmle_step_1");
  assert.equal(catalog.total, 1);
  assert.equal(catalog.resources[0].id, "reading-2");
  assert.equal(catalog.resources[0].progress.progress_percent, 40);
  assert.equal(catalog.continue_reading[0].id, "reading-2");
  assert.equal(catalog.books.length, 1);
  assert.deepEqual(catalog.facets.systems, ["Cardiovascular", "Renal"]);
  assert.deepEqual(catalog.facets.books, ["AylaMed Reading", "First Aid"]);
  assert.doesNotMatch(JSON.stringify(catalog), /Internal renal notes/i);

  const hiddenSourceSearch = buildAylaLibraryCatalog({
    examTrack: "usmle_step_1",
    studentId: "s1",
    resources: [renal],
    filters: { search: "Internal renal notes" },
  });
  assert.equal(hiddenSourceSearch.total, 0);
});

test("roadmap chooses exact-topic page reading, resumes it, and skips completed resources", () => {
  const exact = reading();
  const systemWide = reading({
    id: "system-reading",
    topic: "Cardiac physiology",
    pdfPageStart: 30,
    pdfPageEnd: 30,
    printedPageStart: 20,
    printedPageEnd: 20,
    readerPages: [{ pdfPage: 30, printedPage: 20, text: "Physiology.", complete: true }],
  });
  const first = selectAylaRoadmapReading({
    examTrack: "usmle_step_1",
    resources: [systemWide, exact],
    focusSystem: "Cardiovascular",
    focusTopic: "Murmurs",
    progressRows: [{ resourceId: "reading-1", readPageKeys: ["pdf:12"], totalPages: 2, progressPercent: 50 }],
  });
  assert.equal(first.resource.id, "reading-1");
  assert.equal(first.match_level, "exact_topic");
  assert.equal(first.resumed, true);

  const next = selectAylaRoadmapReading({
    examTrack: "usmle_step_1",
    resources: [systemWide, exact],
    focusSystem: "Cardiovascular",
    focusTopic: "Murmurs",
    progressRows: [{ resourceId: "reading-1", readPageKeys: ["pdf:12", "pdf:13"], totalPages: 2, progressPercent: 100, completed: true }],
  });
  assert.equal(next.resource.id, "system-reading");
  assert.equal(next.match_level, "system");

  const wrongSystemSameTopic = reading({ id: "wrong-system", system: "Renal", topic: "Murmurs" });
  const systemFallback = selectAylaRoadmapReading({
    examTrack: "usmle_step_1",
    resources: [wrongSystemSameTopic, systemWide],
    focusSystem: "Cardiovascular",
    focusTopic: "Murmurs",
  });
  assert.equal(systemFallback.resource.id, "system-reading");
  assert.equal(systemFallback.match_level, "system");
});

test("reading progress is monotonic and completes only after every exact page", () => {
  const resource = normalizeAylaLibraryResource(reading());
  const first = mergeAylaLibraryProgress({}, { id: "p1", pageKey: "pdf:12", read: true }, resource, new Date("2026-07-19T10:00:00.000Z"));
  assert.deepEqual(first.readPageKeys, ["pdf:12"]);
  assert.equal(first.progressPercent, 50);
  assert.equal(first.completed, false);

  const stale = mergeAylaLibraryProgress(first, { pageKey: "pdf:999", read: true, progressPercent: 100, completed: true }, resource, new Date("2026-07-19T10:01:00.000Z"));
  assert.deepEqual(stale.readPageKeys, ["pdf:12"]);
  assert.equal(stale.progressPercent, 50);
  assert.equal(stale.completed, false);

  const complete = mergeAylaLibraryProgress(stale, { pageKey: "pdf:13", read: true }, resource, new Date("2026-07-19T10:02:00.000Z"));
  assert.deepEqual(complete.readPageKeys, ["pdf:12", "pdf:13"]);
  assert.equal(complete.progressPercent, 100);
  assert.equal(complete.completed, true);
});

test("stale database writes preserve page history and multi-resource assignments need every reading", () => {
  const latest = {
    p1: { id: "p1", studentId: "s1", resourceId: "r1", assignmentId: "a1", readPageKeys: ["pdf:1"], totalPages: 2, progressPercent: 50, updatedAt: "2026-07-19T10:05:00.000Z" },
    p2: { id: "p2", studentId: "s1", resourceId: "r2", assignmentId: "a1", readPageKeys: [], totalPages: 1, progressPercent: 0, updatedAt: "2026-07-19T10:04:00.000Z" },
  };
  const incoming = {
    p1: { id: "p1", studentId: "s1", resourceId: "r1", assignmentId: "a1", readPageKeys: ["pdf:2"], totalPages: 2, progressPercent: 50, updatedAt: "2026-07-19T10:00:00.000Z" },
  };
  const merged = mergeAylaLibraryProgressCollection(latest, incoming);
  assert.deepEqual(merged.p1.readPageKeys.sort(), ["pdf:1", "pdf:2"]);
  assert.equal(merged.p1.completed, true);
  assert.equal(merged.p2.progressPercent, 0);

  const partial = aylaLibraryAssignmentProgress({ id: "a1", resourceIds: ["r1", "r2"] }, Object.values(merged));
  assert.equal(partial.completed, false);
  assert.equal(partial.progress_percent, 50);
  const complete = aylaLibraryAssignmentProgress({ id: "a1", resourceIds: ["r1", "r2"] }, [
    merged.p1,
    { ...merged.p2, progressPercent: 100, completed: true },
  ]);
  assert.equal(complete.completed, true);

  const combined = combineAylaLibraryProgressRows([
    { id: "partial-1", readPageKeys: ["pdf:12"], totalPages: 2, progressPercent: 50, updatedAt: "2026-07-19T10:00:00.000Z" },
    { id: "partial-2", readPageKeys: ["pdf:13"], totalPages: 2, progressPercent: 50, updatedAt: "2026-07-19T10:01:00.000Z" },
  ]);
  assert.deepEqual(combined.readPageKeys.sort(), ["pdf:12", "pdf:13"]);
  assert.equal(combined.progressPercent, 100);
  assert.equal(combined.completed, true);
});

test("server wires one entitlement-guarded Library into the existing roadmap without CRM writes", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-multiexam-publication-taxonomy-v220"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/library"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/library\/resources\/:resourceId"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/library\/resources\/:resourceId\/pages\/:pageNumber"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/library\/resources\/:resourceId\/search"/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/library\/resources\/:resourceId\/progress"/);
  assert.match(server, /aylaV189RequireStudent\(req, req\.params\.studentId, "library"\)/);
  assert.match(server, /function aylaV189BuildDailyPlan[\s\S]*?selectAylaRoadmapReading\(/);
  assert.match(server, /mergeAylaLibraryProgressCollection\([\s\S]*?aylaDbCache\.aylaReadingProgress/);
  assert.match(server, /category === "reading"[\s\S]*?delete next\.sourceUrl/);
  assert.match(server, /hydrateAylaLibraryResourceFromCrm\(/);
  assert.match(server, /Cache-Control", "private, no-store"/);
  assert.match(server, /readingProgress: aylaV211SanitizeReadingProgress\(result\.progress\)/);
  const libraryRoutes = server.slice(server.indexOf("// v211 Library:"), server.indexOf("app.get(\"/api/ayla/students/:studentId/content-hub\""));
  assert.doesNotMatch(libraryRoutes, /writeCrmDb\(/);
  assert.doesNotMatch(libraryRoutes, /sourceUrl\s*:|source_url\s*:/);
});
