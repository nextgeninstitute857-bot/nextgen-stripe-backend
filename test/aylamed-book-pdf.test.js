import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyOriginalBookPdf,
  bookPdfObjectKey,
  hasPdfSignature,
  parseHttpByteRange,
  privateBookPdfCatalog,
} from "../lib/aylamed-book-pdf.js";

function resource(overrides = {}) {
  return {
    id: "book-resource-1",
    type: "book",
    title: "Cardiology",
    bookTitle: "First Aid 2026",
    edition: "2026",
    folderId: "first-aid-usmle-step-1-2026",
    sourceAccessMode: "protected",
    authorizationStatus: "licensed",
    approved: true,
    status: "active",
    readerPages: [{ pdfPage: 22, printedPage: 10, text: "Exact page.", complete: true }],
    ...overrides,
  };
}

test("original private PDF mapping preserves publication and hides storage internals from the catalog", () => {
  const input = resource({ globalStudentPublication: false, pilotOnly: true });
  const objectKey = bookPdfObjectKey({
    bookKey: "first-aid-usmle-step-1-2026",
    fingerprint: "a".repeat(64),
  });
  const updated = applyOriginalBookPdf([input], {
    bookKey: "first-aid-usmle-step-1-2026",
    objectKey,
    sizeBytes: 123456,
    fingerprint: "a".repeat(64),
    originalFilename: "First Aid 2026.pdf",
    importedAt: "2026-08-15T12:00:00.000Z",
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].globalStudentPublication, false);
  assert.equal(updated[0].pilotOnly, true);
  assert.equal(updated[0].sourcePdf.objectKey, objectKey);
  const catalog = privateBookPdfCatalog(updated);
  assert.equal(catalog[0].original_pdf_ready, true);
  assert.equal(catalog[0].original_pdf_filename, "First-Aid-2026.pdf");
  assert.doesNotMatch(JSON.stringify(catalog), /content\/book-pdf|objectKey|fingerprint/i);
});

test("PDF signature and HTTP byte ranges are validated for private streaming", () => {
  assert.equal(hasPdfSignature(Buffer.from("%PDF-1.7\n")), true);
  assert.equal(hasPdfSignature(Buffer.from("plain text")), false);
  assert.deepEqual(parseHttpByteRange("", 100), { start: 0, endExclusive: 100, partial: false });
  assert.deepEqual(parseHttpByteRange("bytes=10-19", 100), { start: 10, endExclusive: 20, partial: true });
  assert.deepEqual(parseHttpByteRange("bytes=95-", 100), { start: 95, endExclusive: 100, partial: true });
  assert.deepEqual(parseHttpByteRange("bytes=-5", 100), { start: 95, endExclusive: 100, partial: true });
  assert.equal(parseHttpByteRange("bytes=100-101", 100), null);
  assert.equal(parseHttpByteRange("bytes=1-2,4-5", 100), null);
});

test("server wires original PDFs through private upload, durable R2 copy, and entitlement-gated range streaming", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/resources\/book-pdf\/import"/);
  assert.match(server, /ngReceiveOrResolveContentZip\(req, \["book_pdf"\]\)/);
  assert.match(server, /copyContentR2Object\(stagingObjectKey, durableObjectKey/);
  assert.match(server, /publication_changed: false/);
  assert.match(server, /student_access_changed: false/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/library\/resources\/:resourceId\/original\.pdf"/);
  assert.match(server, /aylaV189RequireStudent\(req, req\.params\.studentId, "library"\)/);
  assert.match(server, /Content-Range/);
  assert.match(server, /getContentR2ObjectStream\(pdf\.objectKey/);
});
