import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyBookMediaMatches,
  authorizedBookMediaResources,
  collectBookMediaReferences,
} from "../lib/aylamed-book-media.js";

function resource(overrides = {}) {
  return {
    id: "book-resource-1",
    type: "book",
    folderId: "first-aid-step-1",
    sourceAccessMode: "protected",
    authorizationStatus: "authorized",
    approved: true,
    status: "active",
    readerPages: [{
      pdfPage: 12,
      printedPage: "2.1",
      text: "A protected page.\n\n[Figure: Cardiac cycle]",
      mediaReferences: [{
        id: "figure-1",
        ref: "../Images/cardiac-cycle.svg",
        matchPaths: ["media/OEBPS/Images/cardiac-cycle.svg"],
        alt: "Cardiac cycle",
        order: 0,
      }],
    }],
    ...overrides,
  };
}

test("private book references are collected only from the exact protected authorized book", () => {
  const eligible = resource();
  const wrongBook = resource({ id: "wrong", folderId: "another-book" });
  const publicResource = resource({ id: "public", sourceAccessMode: "public" });
  assert.deepEqual(authorizedBookMediaResources([eligible, wrongBook, publicResource], "first-aid-step-1").map((row) => row.id), ["book-resource-1"]);
  const collected = collectBookMediaReferences([eligible, wrongBook, publicResource], { bookKey: "first-aid-step-1" });
  assert.equal(collected.references.length, 1);
  assert.deepEqual(collected.references[0], {
    resourceId: "book-resource-1",
    pageKey: "pdf:12",
    referenceId: "figure-1",
    mediaRef: "../Images/cardiac-cycle.svg",
    matchPaths: ["media/OEBPS/Images/cardiac-cycle.svg"],
    alt: "Cardiac cycle",
    caption: "",
    placement: "inline",
    order: 0,
  });
});

test("private book matches update only media delivery fields and preserve publication state", () => {
  const input = resource();
  const reference = collectBookMediaReferences([input], { bookKey: "first-aid-step-1" }).references[0];
  const applied = applyBookMediaMatches([input], {
    matches: [{
      ...reference,
      asset: {
        objectKey: "content/image/books/first-aid/private.svg",
        originalName: "media/OEBPS/Images/cardiac-cycle.svg",
        contentType: "image/svg+xml",
        sha256: "a".repeat(64),
        sizeBytes: 123,
      },
    }],
    missing: [],
    ambiguous: [],
  }, { bookKey: "first-aid-step-1", importedAt: "2026-08-15T12:00:00.000Z" });
  assert.equal(applied.counts.linked, 1);
  assert.equal(applied.counts.missing, 0);
  assert.equal(applied.resources[0].approved, true);
  assert.equal(applied.resources[0].status, "active");
  assert.equal(applied.resources[0].sourceAccessMode, "protected");
  assert.equal(applied.resources[0].requiredMediaMissingCount, 0);
  assert.equal(applied.resources[0].sourceData.delivery_media_ready, true);
  assert.equal(applied.resources[0].readerPages[0].media[0].objectKey, "content/image/books/first-aid/private.svg");
});

test("book media HTTP wiring uses private resumable storage and does not mutate publication controls", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf('app.post("/api/ayla/admin/resources/book-media/import"');
  const end = server.indexOf('app.get("/api/ayla/admin/resources/coverage"', start);
  const routes = server.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(routes, /ngReceiveOrResolveContentZip\(req, \["book_media_zip"\]\)/);
  assert.match(routes, /type: "ayla_book_media_import"/);
  assert.match(routes, /publication_changed: false/);
  assert.match(routes, /student_access_changed: false/);
  assert.doesNotMatch(routes, /updateExamPublication|updateResourcePublication|approved\s*=/);
  assert.match(server, /createPrivateMediaUrl\(objectKey, 900\)/);
  assert.match(server, /page\.page\.media = await aylaV251SignedMediaRows/);
});
