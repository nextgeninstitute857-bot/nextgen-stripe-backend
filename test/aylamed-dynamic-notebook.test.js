import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaNotebookSourceFingerprint,
  aylaNotebookTimestampLabel,
  aylaNotebookTimestampSeconds,
  buildAylaNotebookDeepLink,
  createAylaNotebookCaptureBlocks,
  mergeConcurrentAylaNotebookCollection,
  normalizeAylaNotebookSourceKind,
  plainTextFromAylaNotebookHtml,
  sanitizeAylaNotebook,
  sanitizeAylaNotebookBlock,
  selectAylaNotebookSourceExcerpt,
} from "../lib/aylamed-dynamic-notebook.js";

test("Dynamic Notebook normalizes only supported cross-surface sources and bounded timestamps", () => {
  assert.equal(normalizeAylaNotebookSourceKind("book-page"), "library_page");
  assert.equal(normalizeAylaNotebookSourceKind("vimeo_video"), "content_video");
  assert.equal(normalizeAylaNotebookSourceKind("qbank"), "qbank_question");
  assert.equal(normalizeAylaNotebookSourceKind("unknown"), null);
  assert.equal(aylaNotebookTimestampSeconds("1:23"), 83);
  assert.equal(aylaNotebookTimestampSeconds("1:02:03"), 3723);
  assert.equal(aylaNotebookTimestampSeconds(900, { durationSeconds: 600 }), 600);
  assert.equal(aylaNotebookTimestampLabel(3723), "1:02:03");
});

test("return links stay internal and preserve exact Library pages and embedded video timestamps", () => {
  assert.deepEqual(buildAylaNotebookDeepLink({
    sourceType: "library_page",
    resourceId: "reading 1",
    pageKey: "pdf:12",
    assignmentId: "assignment 1",
  }), {
    surface: "library",
    label: "Return to this page",
    href: "/dashboard/library/reading%201/page/pdf%3A12?assignment=assignment+1",
  });
  assert.deepEqual(buildAylaNotebookDeepLink({
    sourceType: "content_video",
    resourceId: "video-1",
    timestampSeconds: 83,
  }), {
    surface: "content_hub",
    label: "Return to 1:23",
    href: "/dashboard/content-hub/video-1?t=83",
  });
  const qbank = buildAylaNotebookDeepLink({ sourceType: "qbank_question", sessionId: "session-1", questionRef: "Q 1" });
  assert.equal(qbank.href, "/dashboard/qbank/session/session-1?question=Q+1");
  assert.doesNotMatch(JSON.stringify([qbank]), /https?:|vimeo\.com|player\.vimeo/i);
});

test("source excerpts are derived from current canonical content, never trusted arbitrary client text", () => {
  const html = "<p>Cardiac output equals heart rate &times; stroke volume.</p><script>alert(1)</script>";
  assert.equal(plainTextFromAylaNotebookHtml(html), "Cardiac output equals heart rate &times; stroke volume.");
  assert.equal(selectAylaNotebookSourceExcerpt(html, "heart rate &times; stroke volume"), "heart rate &times; stroke volume");
  assert.equal(selectAylaNotebookSourceExcerpt(html, "fabricated answer"), null);
  assert.equal(selectAylaNotebookSourceExcerpt("Approved page text", ""), "Approved page text");
});

test("capture creates a clean imported-source block and a separate handwriting-style student note", () => {
  let id = 0;
  const source = {
    kind: "content_video",
    resourceId: "video-1",
    providerVideoId: "private-vimeo-123",
    timestampSeconds: 83,
    durationSeconds: 600,
    title: "Cardiac murmurs",
    reference: "Video timestamp 1:23",
    examTrackId: "usmle_step_1",
  };
  const capture = createAylaNotebookCaptureBlocks({
    source,
    noteText: "I confuse opening snaps with ejection clicks.",
    idFactory: () => `block-${++id}`,
    now: new Date("2026-07-20T00:00:00.000Z"),
  });
  assert.equal(capture.blocks.length, 2);
  assert.equal(capture.blocks[0].contentOrigin, "approved_source");
  assert.equal(capture.blocks[0].visualStyle, "clean");
  assert.equal(capture.blocks[1].contentOrigin, "student_authored");
  assert.equal(capture.blocks[1].visualStyle, "handwriting");
  assert.equal(capture.blocks[1].linkedCaptureKey, capture.captureKey);

  const safe = sanitizeAylaNotebookBlock(capture.blocks[0], { currentSource: source });
  assert.equal(safe.returnLink.href, "/dashboard/content-hub/video-1?t=83");
  assert.equal(safe.timestampLabel, "1:23");
  assert.doesNotMatch(JSON.stringify(safe), /private-vimeo-123|providerVideoId|vimeoId|sourceUrl|https?:/i);
});

test("revoked sources fail closed without erasing the student's separate authored note", () => {
  const sourceBlock = createAylaNotebookCaptureBlocks({
    source: {
      kind: "library_page",
      resourceId: "reading-1",
      pageKey: "pdf:12",
      title: "Murmurs",
      reference: "Page 12",
      excerpt: "Previously approved source text.",
    },
    noteText: "My own mnemonic remains available.",
    idFactory: (() => { let index = 0; return () => `b-${++index}`; })(),
  }).blocks;
  const notebook = sanitizeAylaNotebook({
    id: "note-1",
    studentId: "student-1",
    examTrackId: "usmle_step_1",
    title: "Murmurs",
    blocks: sourceBlock,
  }, {
    currentSources: new Map([[sourceBlock[0].id, { kind: "library_page", available: false }]]),
  });
  assert.equal(notebook.blocks[0].sourceState, "unavailable");
  assert.equal(notebook.blocks[0].text, "");
  assert.equal(notebook.blocks[0].returnLink, null);
  assert.equal(notebook.blocks[1].text, "My own mnemonic remains available.");
  const unvalidatedLegacy = sanitizeAylaNotebookBlock({
    id: "legacy-question",
    type: "question_source",
    text: "Legacy imported answer text.",
  });
  assert.equal(unvalidatedLegacy.sourceState, "unavailable");
  assert.equal(unvalidatedLegacy.text, "");
});

test("student notebook output strips raw source URLs, provider IDs, and answer-key fields", () => {
  const block = {
    id: "source-1",
    type: "question_source",
    text: "Authorized explanation after submission.",
    sourceType: "qbank_question",
    sourceTitle: "Question NGQ-00000001",
    sourceReference: "Question NGQ-00000001",
    sourceUrl: "https://private.example/source",
    vimeoId: "123456789",
    correctAnswer: "C",
    source: {
      kind: "qbank_question",
      resourceId: "private-provider-question-id",
      sessionId: "session-1",
      questionRef: "question-1",
      providerVideoId: "private-vimeo-id",
    },
  };
  const safe = sanitizeAylaNotebookBlock(block, {
    currentSource: {
      kind: "qbank_question",
      available: true,
      sessionId: "session-1",
      questionRef: "question-1",
      title: "Question NGQ-00000001",
      reference: "Question NGQ-00000001",
      excerpt: "Authorized explanation after submission.",
    },
  });
  assert.equal(safe.returnLink.href, "/dashboard/qbank/session/session-1?question=question-1");
  assert.doesNotMatch(JSON.stringify(safe), /private-provider|private-vimeo|sourceUrl|vimeoId|correctAnswer|https?:/i);
});

test("capture fingerprints are deterministic and distinguish timestamps and student notes", () => {
  const source = { kind: "content_video", resourceId: "v1", timestampSeconds: 90 };
  assert.equal(aylaNotebookSourceFingerprint(source, "note"), aylaNotebookSourceFingerprint(source, "note"));
  assert.notEqual(aylaNotebookSourceFingerprint(source, "note"), aylaNotebookSourceFingerprint({ ...source, timestampSeconds: 91 }, "note"));
  assert.notEqual(aylaNotebookSourceFingerprint(source, "note"), aylaNotebookSourceFingerprint(source, "different"));
});

test("stale general writes cannot erase newer notebooks or immutable versions", () => {
  const latest = {
    n1: { id: "n1", title: "New", updatedAt: "2026-07-20T00:05:00.000Z" },
    n2: { id: "n2", title: "Preserved", updatedAt: "2026-07-20T00:04:00.000Z" },
  };
  const incoming = {
    n1: { id: "n1", title: "Stale", updatedAt: "2026-07-20T00:01:00.000Z" },
  };
  const merged = mergeConcurrentAylaNotebookCollection(latest, incoming);
  assert.equal(merged.n1.title, "New");
  assert.equal(merged.n2.title, "Preserved");
});

test("server wires v212 capture through the existing entitlement and isolated Ayla mutation boundary", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 13/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/notebooks\/capture"/);
  assert.match(server, /aylaV189RequireStudent\(req, req\.params\.studentId, "dynamic_notebook"\)/);
  assert.match(server, /async function aylaV212ResolveNotebookSource/);
  assert.match(server, /aylaDashboardEntitlement\(db, user, student, "library"\)/);
  assert.match(server, /aylaDashboardEntitlement\(db, user, student, "content_hub"\)/);
  assert.match(server, /Correct answers and explanations remain server-only until tutor-mode answer submission or final test submission/);
  assert.match(server, /mergeConcurrentAylaNotebookCollection/);
  const section = server.slice(server.indexOf("// v190D Smart Dynamic Notebook"), server.indexOf('app.get("/api/ayla/community/profile"'));
  assert.match(section, /mutateAylaDb\(async \(db\)/);
  assert.doesNotMatch(section, /writeLiveDb\s*\(/);
  assert.doesNotMatch(section, /writeCrmDb\s*\(/);
});
