import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outputPath = path.resolve(
  process.argv[2] || path.join(root, "tmp", "step1-pilot-books.json"),
);
const cohortId = String(
  process.env.AYLA_PILOT_COHORT_ID || "AYLA-PILOT-161049-2C000388",
).trim();
const rightsStatus = String(
  process.env.AYLA_PILOT_BOOK_RIGHTS_STATUS || "pending_review",
).trim().toLowerCase();

if (!cohortId) throw new Error("AYLA_PILOT_COHORT_ID is required");

const books = [
  {
    id: "AYLA-PILOT-BOOK-FA2025-CARDIO-304-309",
    input: path.resolve(root, "../upload/First Aid for the USMLE Step 1 2025 35th Edition.pdf"),
    title: "Cardiovascular pilot reading",
    bookTitle: "First Aid for the USMLE Step 1",
    edition: "2025, 35th Edition",
    provider: "McGraw Hill",
    system: "Cardiovascular",
    topic: "Cardiovascular foundations",
    pdfPageStart: 304,
    pdfPageEnd: 309,
    printedPageStart: 283,
  },
  {
    id: "AYLA-PILOT-BOOK-PATHOMA-CARDIAC-80-84",
    input: path.resolve(root, "../upload/fundamentals-of-pathology-pathoma.pdf"),
    title: "Cardiac pathology pilot reading",
    bookTitle: "Fundamentals of Pathology",
    edition: "Pilot source edition",
    provider: "Pathoma",
    system: "Cardiovascular",
    topic: "Cardiac pathology",
    pdfPageStart: 80,
    pdfPageEnd: 84,
    printedPageStart: 73,
  },
];

function extractPage(file, page) {
  const text = execFileSync("pdftotext", [
    "-f",
    String(page),
    "-l",
    String(page),
    "-layout",
    file,
    "-",
  ], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).replace(/\f/g, "").trim();
  if (text.length < 80) {
    throw new Error(`PDF page ${page} in ${path.basename(file)} is not readable enough for pilot import`);
  }
  return text;
}

const resources = books.map((book) => {
  if (!fs.existsSync(book.input)) throw new Error(`Missing pilot book: ${book.input}`);
  const readerPages = [];
  for (let pdfPage = book.pdfPageStart; pdfPage <= book.pdfPageEnd; pdfPage += 1) {
    readerPages.push({
      pdfPage,
      printedPage: book.printedPageStart + (pdfPage - book.pdfPageStart),
      text: extractPage(book.input, pdfPage),
      complete: true,
      exactReference: `${book.bookTitle}, ${book.edition}, PDF page ${pdfPage}`,
    });
  }
  return {
    id: book.id,
    type: "book",
    title: book.title,
    description: "Private Step 1 pilot excerpt for exact-page reader, Roadmap, progress, and notebook testing.",
    examTrackId: "usmle_step_1",
    bookTitle: book.bookTitle,
    edition: book.edition,
    provider: book.provider,
    system: book.system,
    topic: book.topic,
    pdfPageStart: book.pdfPageStart,
    pdfPageEnd: book.pdfPageEnd,
    printedPageStart: book.printedPageStart,
    printedPageEnd: book.printedPageStart + (book.pdfPageEnd - book.pdfPageStart),
    pageRange: `PDF ${book.pdfPageStart}–${book.pdfPageEnd}`,
    exactReference: `${book.bookTitle}, ${book.edition}`,
    readerPages,
    estimatedMinutes: readerPages.length * 4,
    accessScope: "private_pilot",
    pilotOnly: true,
    pilotCohortId: cohortId,
    authorizationStatus: rightsStatus,
    verificationStatus: "pilot_verified_exact_pages",
    sourceAccessMode: "protected",
    sourceLabelVisible: true,
    approved: rightsStatus !== "pending_review",
    status: rightsStatus === "pending_review" ? "needs_rights_review" : "active",
    deliveryDestinations: ["aylamed_library", "aylamed_roadmap"],
  };
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({
  resources,
  pilot: {
    cohortId,
    public: false,
    ordinaryStudentVisibility: false,
    rightsStatus,
    note: rightsStatus === "pending_review"
      ? "Do not publish until sharing rights are confirmed."
      : "Prepared for private pilot publication only.",
  },
}, null, 2)}\n`);

process.stdout.write(`${outputPath}\n`);
