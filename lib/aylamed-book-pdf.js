import path from "node:path";
import { authorizedBookMediaResources, authorizedPrivateBookResources } from "./aylamed-book-media.js";

function cleanString(value = "", maximum = 1_000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

function bookKeyOf(resource = {}) {
  return cleanString(resource.folderId || resource.folder_id, 180).toLowerCase();
}

function safePdfFilename(value = "book.pdf") {
  const basename = path.basename(cleanString(value, 240) || "book.pdf");
  const stem = basename.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${stem || "book"}.pdf`;
}

export function bookPdfObjectKey({ bookKey = "", fingerprint = "" } = {}) {
  const cleanKey = cleanString(bookKey, 180).toLowerCase();
  const cleanFingerprint = cleanString(fingerprint, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,179}$/.test(cleanKey)) throw Object.assign(new Error("A valid prepared book_key is required"), { statusCode: 400 });
  if (!/^[0-9a-f]{64}$/.test(cleanFingerprint)) throw Object.assign(new Error("A valid private PDF fingerprint is required"), { statusCode: 400 });
  return `content/book-pdf/${cleanKey}/${cleanFingerprint}.pdf`;
}

export function normalizeOriginalBookPdf(resource = {}) {
  const input = resource.sourcePdf || resource.source_pdf;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const objectKey = cleanString(input.objectKey || input.object_key, 1_000);
  const sizeBytes = Math.max(0, Number(input.sizeBytes || input.size_bytes || 0));
  if (!objectKey || !sizeBytes) return null;
  return {
    objectKey,
    sizeBytes,
    fingerprint: cleanString(input.fingerprint || input.sha256, 80),
    originalFilename: safePdfFilename(input.originalFilename || input.original_filename),
    importedAt: input.importedAt || input.imported_at || null,
    pageCount: Math.max(0, Number(input.pageCount || input.page_count || 0)) || null,
    accessMode: "protected",
  };
}

export function privateBookPdfCatalog(resources = []) {
  const books = new Map();
  for (const resource of authorizedPrivateBookResources(resources)) {
    const bookKey = bookKeyOf(resource);
    if (!bookKey) continue;
    const pdf = normalizeOriginalBookPdf(resource);
    const current = books.get(bookKey) || {
      book_key: bookKey,
      title: cleanString(resource.bookTitle || resource.book_title || resource.title, 240) || bookKey,
      edition: cleanString(resource.edition, 100),
      resource_count: 0,
      original_pdf_ready: false,
      original_pdf_filename: null,
      original_pdf_imported_at: null,
    };
    current.resource_count += 1;
    if (pdf) {
      current.original_pdf_ready = true;
      current.original_pdf_filename = pdf.originalFilename;
      current.original_pdf_imported_at = pdf.importedAt;
    }
    books.set(bookKey, current);
  }
  return [...books.values()].sort((left, right) => String(left.title).localeCompare(String(right.title)) || left.book_key.localeCompare(right.book_key));
}

export function applyOriginalBookPdf(resources = [], {
  bookKey = "",
  objectKey = "",
  sizeBytes = 0,
  fingerprint = "",
  originalFilename = "book.pdf",
  importedAt = new Date().toISOString(),
} = {}) {
  const eligible = authorizedBookMediaResources(resources, bookKey);
  if (!eligible.length) throw Object.assign(new Error("Protected book resources were not found"), { statusCode: 404 });
  const sourcePdf = {
    objectKey: cleanString(objectKey, 1_000),
    sizeBytes: Math.max(0, Number(sizeBytes || 0)),
    fingerprint: cleanString(fingerprint, 80),
    originalFilename: safePdfFilename(originalFilename),
    importedAt,
    accessMode: "protected",
  };
  if (!sourcePdf.objectKey || !sourcePdf.sizeBytes) throw Object.assign(new Error("The durable private PDF object is incomplete"), { statusCode: 409 });
  return eligible.map((resource) => ({
    ...resource,
    sourcePdf,
    sourceData: {
      ...(resource.sourceData && typeof resource.sourceData === "object" ? resource.sourceData : {}),
      original_pdf_ready: true,
      original_pdf_imported_at: importedAt,
    },
    updatedAt: importedAt,
  }));
}

export function hasPdfSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function parseHttpByteRange(value, totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isSafeInteger(total) || total < 1) return null;
  const raw = cleanString(value, 200);
  if (!raw) return { start: 0, endExclusive: total, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= total) return null;
    end = Math.min(end, total - 1);
  }
  return { start, endExclusive: end + 1, partial: true };
}
