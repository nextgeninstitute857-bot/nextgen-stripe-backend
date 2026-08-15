import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const inputRoot = path.resolve(process.argv[2] || "");
const outputRoot = path.resolve(process.argv[3] || path.join(process.cwd(), "tmp", "authorized-books-prepared"));
const MAX_PACKAGE_BYTES = 14 * 1024 * 1024;
const MAX_PAGE_CHARS = 48_000;

if (!inputRoot || !fs.existsSync(inputRoot)) {
  throw new Error("Usage: node scripts/prepare-authorized-structured-books.mjs <extracted-books-directory> [output-directory]");
}

const BOOKS = Object.freeze([
  {
    directory: "First Aid for the USMLE Step 1",
    key: "first-aid-usmle-step-1-2023",
    title: "First Aid for the USMLE Step 1",
    edition: "2023 edition",
    examTrackId: "usmle_step_1",
  },
  {
    directory: "First Aid for the USMLE Step 2",
    key: "first-aid-usmle-step-2-cs-fifth",
    title: "First Aid for the USMLE Step 2 CS",
    edition: "Fifth edition",
    examTrackId: "usmle_step_2_ck",
  },
  {
    directory: "Master The Boards USMLE Step 2",
    key: "master-the-boards-usmle-step-2",
    title: "Master the Boards USMLE Step 2 CK",
    edition: "Source edition pending bibliographic review",
    examTrackId: "usmle_step_2_ck",
  },
  {
    directory: "Master The Boards USMLE Step 3",
    key: "master-the-boards-usmle-step-3-third",
    title: "Master the Boards USMLE Step 3",
    edition: "Third edition",
    examTrackId: "usmle_step_3",
  },
  {
    directory: "Oxford Handbook of Clinical Medicine",
    key: "oxford-handbook-clinical-medicine-tenth",
    title: "Oxford Handbook of Clinical Medicine",
    edition: "Tenth edition",
    examTrackId: "plab",
  },
  {
    directory: "Oxford Handbook of Clinical Specialties",
    key: "oxford-handbook-clinical-specialties-eleventh",
    title: "Oxford Handbook of Clinical Specialties",
    edition: "Eleventh edition",
    examTrackId: "plab",
  },
]);

const SYSTEM_RULES = Object.freeze([
  ["Cardiovascular", /cardi|heart|vascular|hypertension|arrhythm|ecg|shock/i],
  ["Respiratory", /respirat|pulmon|lung|asthma|copd|pneum|pleur/i],
  ["Renal", /renal|kidney|nephro|electrolyte|acid.base/i],
  ["Gastrointestinal", /gastro|intestinal|liver|hepatic|biliar|pancrea|bowel|abdomen/i],
  ["Endocrine", /endocr|diabet|thyroid|adrenal|pituitar|metabolic/i],
  ["Reproductive", /reproduc|obstetric|gynecol|pregnan|antenatal|postnatal|breast|testic|prostat/i],
  ["Neurology", /neuro|brain|spinal|seizure|stroke|headache|neuromuscular/i],
  ["Psychiatry", /psychi|mental|behavior|mood|anxiety|psychosis|substance/i],
  ["Musculoskeletal", /musculo|orthop|rheumat|bone|joint|fracture|sports medicine/i],
  ["Hematology and Oncology", /hemat|haemat|oncolog|cancer|tumou?r|leuk|lymph|anemia|anaemia/i],
  ["Immunology", /immun|allerg|transplant/i],
  ["Infectious Disease", /infect|microbio|bacter|viral|virus|fung|parasit|antibiotic/i],
  ["Dermatology", /dermat|skin|rash/i],
  ["Pediatrics", /paediatr|pediatr|child|neonat|infant/i],
  ["Surgery", /surg|perioperative|trauma|wound|anesth|anaesth/i],
  ["Emergency Medicine", /emergenc|resusc|acute care|critical care/i],
  ["Pharmacology", /pharm|drug|toxic|poison/i],
  ["Biochemistry and Genetics", /biochem|genetic|molecular|chrom|nucleotide|metabolism/i],
  ["Pathology", /patholog|inflammation|neoplas|cell injury/i],
  ["Public Health and Ethics", /public health|epidemi|biostat|ethic|legal|communication|quality|safety/i],
]);

function decodeEntities(value = "") {
  const named = new Map([
    ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"],
    ["nbsp", " "], ["ndash", "–"], ["mdash", "—"], ["hellip", "…"], ["times", "×"],
    ["plusmn", "±"], ["micro", "µ"], ["deg", "°"], ["copy", "©"], ["reg", "®"],
  ]);
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, token) => {
    if (token[0] !== "#") return named.get(token.toLowerCase()) ?? match;
    const radix = token[1]?.toLowerCase() === "x" ? 16 : 10;
    const clean = radix === 16 ? token.slice(2) : token.slice(1);
    const code = Number.parseInt(clean, radix);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

function imageReferences(html = "") {
  const refs = [];
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const ref = decodeEntities(match[2]).trim().replace(/^\.\//, "");
    if (ref && !ref.startsWith("data:")) refs.push(ref);
  }
  return [...new Set(refs)];
}

function imageAttribute(tag = "", name = "") {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeEntities(match[2]).trim() : "";
}

function htmlToReaderText(html = "") {
  const mediaTokens = [];
  let text = String(html || "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const ref = imageAttribute(tag, "src").replace(/^\.\//, "");
      const label = imageAttribute(tag, "alt") || imageAttribute(tag, "title");
      const figure = label ? `[Figure: ${label}]` : "[Figure]";
      if (!ref || ref.startsWith("data:")) return `\n${figure}\n`;
      const marker = mediaTokens.length.toString(36);
      mediaTokens.push({ ref, alt: label });
      return `\n${figure}\uE000${marker}\uE001\n`;
    })
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:p|div|section|article|header|footer|aside|h[1-6]|li|ul|ol|table|tr|blockquote|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, mediaTokens };
}

function extractPageMedia(text = "", mediaTokens = []) {
  const mediaReferences = [];
  const cleaned = String(text).replace(/\uE000([0-9a-z]+)\uE001/g, (_match, token) => {
    const parsed = mediaTokens[Number.parseInt(token, 36)];
    if (!parsed?.ref) throw new Error("A generated book media marker could not be decoded");
    mediaReferences.push({ ref: String(parsed.ref), alt: String(parsed.alt || "") });
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, mediaReferences };
}

function splitPages(text = "") {
  const paragraphs = String(text).split(/\n{2,}/).map((row) => row.trim()).filter(Boolean);
  const pages = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_PAGE_CHARS) {
      if (current) pages.push(current);
      current = "";
      for (let start = 0; start < paragraph.length; start += MAX_PAGE_CHARS) {
        pages.push(paragraph.slice(start, start + MAX_PAGE_CHARS));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > MAX_PAGE_CHARS && current) {
      pages.push(current);
      current = paragraph;
    } else current = candidate;
  }
  if (current) pages.push(current);
  return pages;
}

function safeKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "section";
}

function classifySystem(title = "", text = "") {
  const sample = `${title} ${String(text).slice(0, 2000)}`;
  return SYSTEM_RULES.find(([, pattern]) => pattern.test(sample))?.[0] || "Integrated Clinical Review";
}

function findJson(directory) {
  const candidates = fs.readdirSync(directory, { withFileTypes: true });
  const direct = candidates.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  if (direct) return path.join(directory, direct.name);
  throw new Error(`No structured JSON source found in ${directory}`);
}

function mediaIndex(directory) {
  const files = [];
  const byExact = new Map();
  const bySuffix = new Map();
  const byName = new Map();
  const append = (index, key, file) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  };
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:png|jpe?g|gif|webp|svg)$/i.test(entry.name)) {
        const relative = path.relative(directory, full).replaceAll("\\", "/");
        const file = { absolute: full, relative, archivePath: `media/${relative}` };
        files.push(file);
        const exact = relative.toLowerCase();
        append(byExact, exact, file);
        append(byName, path.posix.basename(exact), file);
        const parts = exact.split("/").filter(Boolean);
        for (let index = 0; index < parts.length; index += 1) {
          append(bySuffix, parts.slice(index).join("/"), file);
        }
      }
    }
  };
  walk(directory);
  return { files, byExact, bySuffix, byName };
}

function mediaResolution(ref, index) {
  const raw = String(ref).split(/[?#]/)[0].replaceAll("\\", "/").toLowerCase();
  const clean = path.posix.normalize(raw).replace(/^\.\//, "").replace(/^(?:\.\.\/)+/, "").replace(/^\/+/, "");
  const candidates = new Map();
  for (const file of [
    ...(index.byExact.get(clean) || []),
    ...(index.bySuffix.get(clean) || []),
  ]) candidates.set(file.relative.toLowerCase(), file);
  if (!candidates.size) {
    for (const file of index.byName.get(path.posix.basename(clean)) || []) {
      candidates.set(file.relative.toLowerCase(), file);
    }
  }
  const files = [...candidates.values()];
  return {
    file: files.length === 1 ? files[0] : null,
    ambiguous: files.length > 1,
    candidates: files.map((file) => file.relative),
  };
}

function packagesForBook(book, resources) {
  const packages = [];
  let rows = [];
  let bytes = 0;
  for (const resource of resources) {
    const resourceBytes = Buffer.byteLength(JSON.stringify(resource), "utf8") + 2;
    if (rows.length && bytes + resourceBytes > MAX_PACKAGE_BYTES) {
      packages.push(rows);
      rows = [];
      bytes = 0;
    }
    rows.push(resource);
    bytes += resourceBytes;
  }
  if (rows.length) packages.push(rows);
  return packages.map((batch, index) => ({
    filename: `${book.key}.part-${String(index + 1).padStart(2, "0")}.json`,
    payload: {
      version: "aylamed-private-book-import-v1",
      private: true,
      publication_changed: false,
      book: { key: book.key, title: book.title, edition: book.edition, exam_track_id: book.examTrackId },
      resources: batch,
    },
  }));
}

fs.mkdirSync(outputRoot, { recursive: true });
const summary = { version: "aylamed-private-book-import-v1", generated_at: new Date().toISOString(), books: [], totals: {} };

for (const book of BOOKS) {
  const directory = path.join(inputRoot, book.directory);
  const sourceFile = findJson(directory);
  const sourceRows = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const availableMedia = mediaIndex(directory);
  const resources = [];
  let logicalPage = 1;
  let skipped = 0;
  let mediaRefs = 0;
  let mediaRefsFound = 0;
  let mediaRefsAmbiguous = 0;
  const packagedMedia = new Map();
  for (let index = 0; index < sourceRows.length; index += 1) {
    const row = sourceRows[index] || {};
    const html = String(row.doc ?? row.mainContent ?? "");
    const converted = htmlToReaderText(html);
    const text = converted.text;
    const visibleText = extractPageMedia(text, converted.mediaTokens).text;
    if (visibleText.length < 80) {
      skipped += 1;
      continue;
    }
    const title = String(row.title ?? row.name ?? `Section ${index + 1}`).trim().slice(0, 240) || `Section ${index + 1}`;
    const pages = splitPages(text);
    if (!pages.length) {
      skipped += 1;
      continue;
    }
    const refs = imageReferences(html);
    const resolutions = new Map(refs.map((ref) => [ref, mediaResolution(ref, availableMedia)]));
    const found = [...resolutions.values()].filter((resolution) => resolution.file).length;
    const ambiguous = [...resolutions.values()].filter((resolution) => resolution.ambiguous).length;
    for (const resolution of resolutions.values()) {
      if (resolution.file) packagedMedia.set(resolution.file.relative.toLowerCase(), resolution.file);
    }
    mediaRefs += refs.length;
    mediaRefsFound += found;
    mediaRefsAmbiguous += ambiguous;
    const startPage = logicalPage;
    let figureIndex = 0;
    const placedReferences = new Set();
    const readerPages = pages.map((pageText, pageIndex) => {
      const extracted = extractPageMedia(pageText, converted.mediaTokens);
      return {
        pdfPage: logicalPage + pageIndex,
        printedPage: `${index + 1}.${pageIndex + 1}`,
        heading: title,
        text: extracted.text,
        complete: true,
        exactReference: `${book.title}, ${book.edition}, source section ${index + 1}`,
        mediaReferences: extracted.mediaReferences.filter((reference) => {
          if (placedReferences.has(reference.ref)) return false;
          placedReferences.add(reference.ref);
          return true;
        }).map((reference) => {
          figureIndex += 1;
          const resolution = resolutions.get(reference.ref) || mediaResolution(reference.ref, availableMedia);
          return {
            id: `figure-${figureIndex}`,
            ref: reference.ref,
            alt: reference.alt,
            placement: "inline",
            order: figureIndex - 1,
            matchPaths: resolution.file
              ? [resolution.file.archivePath, resolution.file.relative]
              : [],
          };
        }),
      };
    });
    logicalPage += readerPages.length;
    const sourceId = String(row.id ?? row.bookid ?? index + 1);
    const stable = crypto.createHash("sha256").update(`${book.key}:${sourceId}:${row.path ?? row.xpath ?? ""}`).digest("hex").slice(0, 12);
    resources.push({
      id: `AYLA-BOOK-${safeKey(book.key).toUpperCase()}-${safeKey(sourceId).toUpperCase()}-${stable.toUpperCase()}`.slice(0, 180),
      type: "book",
      title,
      description: "Authorized structured book section prepared for the protected AylaMed reader and roadmap.",
      provider: book.title,
      examTrackId: book.examTrackId,
      system: classifySystem(title, visibleText),
      topic: title,
      bookTitle: book.title,
      edition: book.edition,
      folderId: book.key,
      folderName: book.title,
      pdfPageStart: startPage,
      pdfPageEnd: logicalPage - 1,
      printedPageStart: `${index + 1}.1`,
      printedPageEnd: `${index + 1}.${readerPages.length}`,
      pageRange: `Source section ${index + 1}`,
      exactReference: `${book.title}, ${book.edition}, source section ${index + 1}`,
      readerPages,
      estimatedMinutes: Math.max(1, Math.min(240, Math.ceil(visibleText.split(/\s+/).length / 180))),
      authorizationStatus: "authorized",
      verificationStatus: "admin_verified_structured_source",
      sourceAccessMode: "protected",
      sourceLabelVisible: true,
      sourceLabel: book.title,
      approved: true,
      status: "active",
      deliveryDestinations: ["aylamed_library", "aylamed_roadmap"],
      requiredMediaMissingCount: refs.length,
      mediaMatchedSourceCount: found,
      mediaReferenceCount: refs.length,
      sourceData: {
        format: row.doc !== undefined ? "html_document_rows" : "ovid_structured_rows",
        source_section_id: sourceId,
        source_path: String(row.path ?? row.xpath ?? "").slice(0, 1000),
        source_media_references: refs.slice(0, 500),
        source_media_available_count: found,
        delivery_media_ready: refs.length === 0,
      },
    });
  }
  const packages = packagesForBook(book, resources);
  for (const entry of packages) {
    fs.writeFileSync(path.join(outputRoot, entry.filename), `${JSON.stringify(entry.payload)}\n`);
  }
  const mediaDirectory = path.join(outputRoot, `${book.key}.media`);
  fs.rmSync(mediaDirectory, { recursive: true, force: true });
  for (const file of packagedMedia.values()) {
    const destination = path.join(mediaDirectory, file.archivePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolute, destination);
  }
  fs.writeFileSync(path.join(mediaDirectory, "book-media-manifest.json"), `${JSON.stringify({
    version: "aylamed-private-book-media-v1",
    private: true,
    book: { key: book.key, title: book.title, edition: book.edition, exam_track_id: book.examTrackId },
    resource_count: resources.length,
    reference_count: mediaRefs,
    resolved_reference_count: mediaRefsFound,
    ambiguous_reference_count: mediaRefsAmbiguous,
    asset_count: packagedMedia.size,
    assets: [...packagedMedia.values()].map((file) => ({
      archive_path: file.archivePath,
      source_relative_path: file.relative,
    })),
  }, null, 2)}\n`);
  summary.books.push({
    ...book,
    source_file: path.basename(sourceFile),
    source_rows: sourceRows.length,
    resources: resources.length,
    reader_pages: logicalPage - 1,
    skipped_rows: skipped,
    media_files: availableMedia.files.length,
    media_references: mediaRefs,
    media_references_resolved_in_source: mediaRefsFound,
    media_references_ambiguous_in_source: mediaRefsAmbiguous,
    delivery_media_missing: mediaRefs,
    media_package_assets: packagedMedia.size,
    media_package_directory: path.basename(mediaDirectory),
    media_package_filename: `${book.key}.media.zip`,
    package_files: packages.map((entry) => entry.filename),
  });
}

summary.totals = summary.books.reduce((totals, book) => ({
  resources: totals.resources + book.resources,
  reader_pages: totals.reader_pages + book.reader_pages,
  media_files: totals.media_files + book.media_files,
  media_references: totals.media_references + book.media_references,
  media_references_resolved_in_source: totals.media_references_resolved_in_source + book.media_references_resolved_in_source,
  media_references_ambiguous_in_source: totals.media_references_ambiguous_in_source + book.media_references_ambiguous_in_source,
  media_package_assets: totals.media_package_assets + book.media_package_assets,
  package_files: totals.package_files + book.package_files.length,
}), {
  resources: 0,
  reader_pages: 0,
  media_files: 0,
  media_references: 0,
  media_references_resolved_in_source: 0,
  media_references_ambiguous_in_source: 0,
  media_package_assets: 0,
  package_files: 0,
});

fs.writeFileSync(path.join(outputRoot, "book-import-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
