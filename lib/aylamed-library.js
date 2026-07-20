import { normalizeAylaRegistryExamTrack, normalizeAylaShellExamTrack } from "./aylamed-student-shell.js";

const READING_TYPES = new Set(["book", "reading", "revision_sheet"]);
const BLOCKED_STATES = new Set(["archived", "deleted", "disabled", "inactive", "quarantined", "rejected"]);
const VERIFIED_RIGHTS = new Set(["authorized", "admin_verified", "licensed", "owned"]);
const TERMINAL_ASSIGNMENT_STATES = new Set(["cancelled", "canceled", "skipped", "superseded"]);
const MAX_READER_PAGES = 500;
const MAX_PAGE_TEXT_LENGTH = 60000;
const MAX_READER_TEXT_LENGTH = 2000000;

function cleanString(value = "", max = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanPageText(value = "") {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, MAX_PAGE_TEXT_LENGTH);
}

function cleanList(value) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(rows.map((item) => cleanString(item, 180)).filter(Boolean))];
}

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

function positiveInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function verifiedApprovalStatus(value = "") {
  const tokens = cleanString(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_").split("_").filter(Boolean);
  if (tokens.some((token) => ["denied", "not", "pending", "rejected", "revoked", "unapproved", "unverified"].includes(token))) return false;
  return tokens.includes("approved") || tokens.includes("verified");
}

function cleanKey(value = "", fallback = "general") {
  return cleanString(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function resourceType(value = "") {
  const clean = cleanString(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
  if (clean === "book_page" || clean === "pages") return "reading";
  return READING_TYPES.has(clean) ? clean : null;
}

function readerPageKey({ pdfPage = null, printedPage = null, turnNumber = null } = {}) {
  if (positiveInteger(pdfPage)) return `pdf:${positiveInteger(pdfPage)}`;
  if (cleanString(printedPage, 80)) return `printed:${cleanKey(printedPage, "page")}`;
  return `page:${positiveInteger(turnNumber) || 1}`;
}

function pagePathKey(page = {}) {
  return String(page.key || readerPageKey(page)).replace(":", "-");
}

function pageRangeLabel(input = {}, pages = []) {
  const printedStart = input.printedPageStart ?? input.printed_page_start ?? pages[0]?.printedPage;
  const printedEnd = input.printedPageEnd ?? input.printed_page_end ?? pages.at(-1)?.printedPage;
  const pdfStart = positiveInteger(input.pdfPageStart ?? input.pdf_page_start ?? pages[0]?.pdfPage);
  const pdfEnd = positiveInteger(input.pdfPageEnd ?? input.pdf_page_end ?? pages.at(-1)?.pdfPage);
  const explicit = cleanString(input.pageRange || input.page_range, 120);
  if (explicit) return explicit;
  if (printedStart !== null && printedStart !== undefined && String(printedStart).trim()) {
    return printedEnd !== null && printedEnd !== undefined && String(printedEnd) !== String(printedStart)
      ? `${printedStart}–${printedEnd}`
      : String(printedStart);
  }
  if (pdfStart) return pdfEnd && pdfEnd !== pdfStart ? `PDF ${pdfStart}–${pdfEnd}` : `PDF ${pdfStart}`;
  return "";
}

function rawReaderPages(input = {}) {
  const direct = input.readerPages || input.reader_pages || input.pageContents || input.page_contents;
  if (Array.isArray(direct)) return direct;
  const pageTexts = input.pageTexts || input.page_texts;
  const start = positiveInteger(input.pdfPageStart ?? input.pdf_page_start) || 1;
  if (Array.isArray(pageTexts)) {
    return pageTexts.map((text, index) => ({ text, pdfPage: start + index }));
  }
  if (pageTexts && typeof pageTexts === "object") {
    return Object.entries(pageTexts).map(([page, text]) => ({ text, pdfPage: positiveInteger(page), printedPage: page }));
  }
  const onePageText = input.pageText || input.page_text || input.readerText || input.reader_text;
  if (onePageText) {
    return [{
      text: onePageText,
      pdfPage: positiveInteger(input.pdfPageStart ?? input.pdf_page_start),
      printedPage: input.printedPageStart ?? input.printed_page_start ?? null,
    }];
  }
  return [];
}

function normalizeReaderPages(input = {}) {
  const pdfStart = positiveInteger(input.pdfPageStart ?? input.pdf_page_start);
  const pdfEnd = positiveInteger(input.pdfPageEnd ?? input.pdf_page_end) || pdfStart;
  const printedStart = positiveInteger(input.printedPageStart ?? input.printed_page_start);
  const rows = rawReaderPages(input).slice(0, MAX_READER_PAGES).map((page, index) => {
    const pdfPage = positiveInteger(page.pdfPage ?? page.pdf_page ?? page.pageNumber ?? page.page_number)
      || (pdfStart ? pdfStart + index : null);
    const printedPage = page.printedPage ?? page.printed_page
      ?? (printedStart ? printedStart + (pdfPage && pdfStart ? pdfPage - pdfStart : index) : null);
    const turnNumber = positiveInteger(page.turnNumber ?? page.turn_number) || index + 1;
    const rawText = String(page.text || page.content || page.pageText || page.page_text || "").replace(/\u0000/g, "").trim();
    return {
      key: readerPageKey({ pdfPage, printedPage, turnNumber }),
      turnNumber,
      pdfPage,
      printedPage: printedPage === null || printedPage === undefined || printedPage === "" ? null : cleanString(printedPage, 80),
      text: cleanPageText(rawText),
      heading: cleanString(page.heading || page.title, 240),
      exactReference: cleanString(page.exactReference || page.exact_reference || input.exactReference || input.exact_reference, 300),
      complete: rawText.length <= MAX_PAGE_TEXT_LENGTH && page.complete !== false && page.contentComplete !== false && page.content_complete !== false,
      blockIndex: positiveInteger(page.blockIndex ?? page.block_index ?? page.index),
    };
  }).filter((page) => page.text && (page.pdfPage || page.printedPage));

  const grouped = new Map();
  for (const page of rows) {
    if (pdfStart && page.pdfPage && page.pdfPage < pdfStart) continue;
    if (pdfEnd && page.pdfPage && page.pdfPage > pdfEnd) continue;
    const existing = grouped.get(page.key);
    if (!existing) {
      grouped.set(page.key, { ...page, parts: [page] });
      continue;
    }
    existing.parts.push(page);
    existing.complete = existing.complete && page.complete;
    existing.heading = existing.heading || page.heading;
    existing.exactReference = existing.exactReference || page.exactReference;
  }

  const pages = [...grouped.values()].map((page) => {
    const parts = page.parts.slice().sort((left, right) => (left.blockIndex || left.turnNumber) - (right.blockIndex || right.turnNumber));
    const joinedText = parts.map((part) => part.text).filter(Boolean).join("\n\n");
    return {
      ...page,
      text: cleanPageText(joinedText),
      complete: page.complete && joinedText.length <= MAX_PAGE_TEXT_LENGTH,
      parts: undefined,
    };
  }).sort((left, right) => (left.pdfPage || Number.MAX_SAFE_INTEGER) - (right.pdfPage || Number.MAX_SAFE_INTEGER)
    || (left.turnNumber || 0) - (right.turnNumber || 0));

  return pages.map((page, index) => ({ ...page, turnNumber: index + 1 }));
}

function hasCompleteExactPages(input = {}, pages = []) {
  if (!pages.length || pages.some((page) => !page.complete || !page.text || (!page.pdfPage && !page.printedPage))) return false;
  const pdfStart = positiveInteger(input.pdfPageStart ?? input.pdf_page_start);
  const pdfEnd = positiveInteger(input.pdfPageEnd ?? input.pdf_page_end) || pdfStart;
  if (!pdfStart) {
    const printedStart = positiveInteger(input.printedPageStart ?? input.printed_page_start);
    const printedEnd = positiveInteger(input.printedPageEnd ?? input.printed_page_end) || printedStart;
    if (!printedStart) return pages.every((page) => Boolean(page.printedPage));
    if (!printedEnd || printedEnd < printedStart || printedEnd - printedStart + 1 > MAX_READER_PAGES) return false;
    const available = new Set(pages.map((page) => positiveInteger(page.printedPage)).filter(Boolean));
    for (let page = printedStart; page <= printedEnd; page += 1) if (!available.has(page)) return false;
    return true;
  }
  if (!pdfEnd || pdfEnd < pdfStart || pdfEnd - pdfStart + 1 > MAX_READER_PAGES) return false;
  const available = new Set(pages.map((page) => page.pdfPage).filter(Boolean));
  for (let page = pdfStart; page <= pdfEnd; page += 1) if (!available.has(page)) return false;
  return true;
}

function sourceLabel(input = {}) {
  const visible = input.sourceLabelVisible === true || input.source_label_visible === true;
  if (!visible) return null;
  return cleanString(
    input.sourceLabel || input.source_label || input.bookTitle || input.book_title || input.provider,
    180,
  ) || null;
}

function approvedTrainingItem(item = {}) {
  if (!item || item.active === false || item.is_active === false || item.deleted_at) return false;
  const states = [item.status, item.approval_status, item.medical_review_status]
    .map((value) => cleanString(value, 80).toLowerCase())
    .filter(Boolean);
  if (states.some((state) => BLOCKED_STATES.has(state))) return false;
  return item.active === true || item.is_active === true || states.some((state) => ["approved", "active_approved", "verified"].includes(state));
}

function approvedDocument(document = {}) {
  if (!document || document.deleted_at) return false;
  const states = [document.status, document.approval_status, document.medical_review_status]
    .map((value) => cleanString(value, 80).toLowerCase())
    .filter(Boolean);
  if (states.some((state) => BLOCKED_STATES.has(state))) return false;
  const rights = cleanString(document.authorization_status || document.authorizationStatus, 80).toLowerCase();
  return !rights || VERIFIED_RIGHTS.has(rights);
}

function blockPageRange(block = {}) {
  const start = positiveInteger(block.pdf_page_start ?? block.pdfPageStart);
  const end = positiveInteger(block.pdf_page_end ?? block.pdfPageEnd) || start;
  return { start, end };
}

function blockIntersectsResource(block = {}, resource = {}) {
  const blockRange = blockPageRange(block);
  const resourceStart = positiveInteger(resource.pdfPageStart ?? resource.pdf_page_start);
  const resourceEnd = positiveInteger(resource.pdfPageEnd ?? resource.pdf_page_end) || resourceStart;
  if (!blockRange.start || !resourceStart) return false;
  return blockRange.start <= resourceEnd && (blockRange.end || blockRange.start) >= resourceStart;
}

export function hydrateAylaLibraryResourceFromCrm({ documents = [], items = [], resource = {} } = {}) {
  const documentId = cleanString(resource.sourceDocumentId || resource.source_document_id, 180);
  const itemId = cleanString(resource.sourceTrainingItemId || resource.source_training_item_id, 180);
  if (!documentId || !itemId) return resource;
  const document = values(documents).find((row) => String(row.id) === documentId);
  if (!approvedDocument(document)) return null;
  const documentItems = values(items).filter((row) => String(row.document_id || row.documentId || "") === documentId);
  const sourceItem = documentItems.find((row) => String(row.id) === itemId);
  if (!approvedTrainingItem(sourceItem)) return null;

  const approvedBlockIndexes = new Set(documentItems.filter(approvedTrainingItem)
    .map((row) => positiveInteger(row.source_block_index ?? row.sourceBlockIndex))
    .filter(Boolean));
  const sourceBlockIndex = positiveInteger(sourceItem.source_block_index ?? sourceItem.sourceBlockIndex);
  const allBlocks = Array.isArray(document.source_blocks) ? document.source_blocks : [];
  const relevantBlocks = allBlocks.filter((block) => {
    if (blockIntersectsResource(block, resource)) return true;
    return !positiveInteger(resource.pdfPageStart ?? resource.pdf_page_start)
      && sourceBlockIndex
      && positiveInteger(block.index) === sourceBlockIndex;
  });
  if (!relevantBlocks.length) return null;

  const pageCompleteness = new Map();
  for (const block of relevantBlocks) {
    const { start } = blockPageRange(block);
    const pageKey = start ? `pdf:${start}` : `block:${positiveInteger(block.index) || 0}`;
    const approved = approvedBlockIndexes.has(positiveInteger(block.index))
      && cleanString(block.status || "processed", 40).toLowerCase() === "processed";
    pageCompleteness.set(pageKey, (pageCompleteness.get(pageKey) ?? true) && approved);
  }

  const printedStart = positiveInteger(resource.printedPageStart ?? resource.printed_page_start);
  const pdfStart = positiveInteger(resource.pdfPageStart ?? resource.pdf_page_start);
  const readerPages = relevantBlocks.filter((block) => approvedBlockIndexes.has(positiveInteger(block.index))).map((block) => {
    const { start } = blockPageRange(block);
    const pageKey = start ? `pdf:${start}` : `block:${positiveInteger(block.index) || 0}`;
    return {
      text: String(block.text || ""),
      pdfPage: start,
      printedPage: printedStart && pdfStart && start ? printedStart + (start - pdfStart) : resource.printedPageStart || resource.printed_page_start || null,
      blockIndex: positiveInteger(block.index),
      complete: pageCompleteness.get(pageKey) === true,
      exactReference: resource.exactReference || resource.exact_reference || "",
    };
  });
  if (!readerPages.length) return null;

  const documentControlsVisibility = Object.prototype.hasOwnProperty.call(document, "source_label_visible")
    || Object.prototype.hasOwnProperty.call(document, "sourceLabelVisible");
  const sourceLabelVisible = documentControlsVisibility
    ? document.source_label_visible === true || document.sourceLabelVisible === true
    : resource.sourceLabelVisible === true || resource.source_label_visible === true;
  return {
    ...resource,
    readerPages,
    sourceLabelVisible,
    sourceLabel: sourceLabelVisible
      ? document.source_label || document.sourceLabel || resource.sourceLabel || resource.source_label || document.provider || document.title || resource.bookTitle || resource.title || ""
      : "",
    readerContentSource: "crm_approved_page_blocks",
  };
}

export function normalizeAylaLibraryResource(input = {}, { examTrack = null } = {}) {
  const type = resourceType(input.type || input.resourceType || input.resource_type);
  const id = cleanString(input.resourceId || input.resource_id || input.id, 180);
  const examTrackId = normalizeAylaShellExamTrack(
    input.examTrackId || input.exam_track_id || input.examTrack || input.exam_track || input.exam,
  );
  const requestedExamTrackId = examTrack ? normalizeAylaShellExamTrack(examTrack) : null;
  const status = cleanString(input.status || "active", 60).toLowerCase();
  const authorizationStatus = cleanString(input.authorizationStatus || input.authorization_status, 80).toLowerCase();
  const verificationStatus = cleanString(input.verificationStatus || input.verification_status, 120).toLowerCase();
  if (!type || !id || !examTrackId || (examTrack && !requestedExamTrackId) || (requestedExamTrackId && requestedExamTrackId !== examTrackId)) return null;
  if (input.approved !== true || BLOCKED_STATES.has(status) || !VERIFIED_RIGHTS.has(authorizationStatus)) return null;
  if (!verifiedApprovalStatus(verificationStatus)) return null;

  if (rawReaderPages(input).length > MAX_READER_PAGES) return null;
  const pages = normalizeReaderPages(input);
  if (!hasCompleteExactPages(input, pages)) return null;
  if (pages.reduce((total, page) => total + page.text.length, 0) > MAX_READER_TEXT_LENGTH) return null;
  const bookTitle = cleanString(input.bookTitle || input.book_title || input.title || input.resourceName || input.resource_name, 240) || "Approved reading";
  const title = cleanString(input.title || input.topic || bookTitle, 240) || bookTitle;
  const system = cleanString(input.system || "General", 120) || "General";
  const topic = cleanString(input.topic || title, 180) || title;
  const label = sourceLabel(input);
  const estimatedMinutes = Math.max(1, Math.min(240, Math.round(Number(input.estimatedMinutes || input.estimated_minutes) || Math.max(5, pages.length * 3))));

  return {
    id,
    aliasResourceIds: [...new Set([id, ...cleanList(input.aliasResourceIds || input.alias_resource_ids)])],
    type,
    title,
    description: cleanString(input.description, 1000),
    examTrackId,
    examTrack: normalizeAylaRegistryExamTrack(examTrackId),
    system,
    topic,
    subtopics: cleanList(input.subtopics),
    bookTitle,
    edition: cleanString(input.edition, 100),
    pageRange: pageRangeLabel(input, pages),
    pdfPageStart: positiveInteger(input.pdfPageStart ?? input.pdf_page_start ?? pages[0]?.pdfPage),
    pdfPageEnd: positiveInteger(input.pdfPageEnd ?? input.pdf_page_end ?? pages.at(-1)?.pdfPage),
    printedPageStart: input.printedPageStart ?? input.printed_page_start ?? pages[0]?.printedPage ?? null,
    printedPageEnd: input.printedPageEnd ?? input.printed_page_end ?? pages.at(-1)?.printedPage ?? null,
    exactReference: cleanString(input.exactReference || input.exact_reference, 300),
    sourceLabel: label,
    sourceLabelVisible: Boolean(label),
    sourceAccessMode: cleanString(input.sourceAccessMode || input.source_access_mode || "protected", 80).toLowerCase(),
    authorizationStatus,
    verificationStatus,
    approved: true,
    status,
    estimatedMinutes,
    priority: cleanString(input.priority || "High", 40),
    relevance: Number.isFinite(Number(input.relevance)) ? Number(input.relevance) : 0,
    readerReady: true,
    readerPageCount: pages.length,
    readerFirstPageKey: pages[0]?.key || null,
    readerLastPageKey: pages.at(-1)?.key || null,
    readerPages: pages,
    sourceTrainingItemId: cleanString(input.sourceTrainingItemId || input.source_training_item_id, 180) || null,
    sourceDocumentId: cleanString(input.sourceDocumentId || input.source_document_id, 180) || null,
    createdAt: input.createdAt || input.created_at || null,
    updatedAt: input.updatedAt || input.updated_at || null,
  };
}

export function normalizeAylaLibraryResources(resources = [], { examTrack = null } = {}) {
  const byId = new Map();
  for (const input of values(resources)) {
    const resource = normalizeAylaLibraryResource(input, { examTrack });
    if (resource) byId.set(resource.id, resource);
  }
  return [...byId.values()].sort((left, right) => String(left.bookTitle).localeCompare(String(right.bookTitle))
    || String(left.system).localeCompare(String(right.system))
    || String(left.topic).localeCompare(String(right.topic))
    || String(left.id).localeCompare(String(right.id)));
}

export function aylaLibraryResourceMatchesId(resource = {}, resourceId = "") {
  const wanted = cleanString(resourceId, 180);
  return Boolean(wanted && [resource.id, ...cleanList(resource.aliasResourceIds)].some((id) => String(id) === wanted));
}

function assignmentMatchesResource(assignment = {}, resource = {}) {
  if (TERMINAL_ASSIGNMENT_STATES.has(cleanString(assignment.status, 40).toLowerCase())) return false;
  if (cleanString(assignment.category || assignment.type, 80).toLowerCase() !== "reading") return false;
  const ids = [
    ...cleanList(assignment.resourceIds || assignment.resource_ids),
    ...values(assignment.items).map((item) => item?.resourceId || item?.resource_id).filter(Boolean),
  ];
  return ids.some((id) => aylaLibraryResourceMatchesId(resource, id));
}

function progressMatchesResource(progress = {}, resource = {}) {
  return aylaLibraryResourceMatchesId(resource, progress.resourceId || progress.resource_id);
}

export function combineAylaLibraryProgressRows(progressRows = []) {
  const rows = values(progressRows).filter(Boolean).sort((left, right) => timestamp(left.updatedAt || left.updated_at) - timestamp(right.updatedAt || right.updated_at));
  if (!rows.length) return null;
  const latest = rows.at(-1);
  const readPageKeys = [...new Set(rows.flatMap((row) => cleanList(row.readPageKeys || row.read_page_keys)))];
  const totalPages = rows.reduce((best, row) => Math.max(best, Number(row.totalPages || row.total_pages) || 0), 0);
  const numericPercent = rows.reduce((best, row) => Math.max(best, Number(row.progressPercent || row.progress_percent) || 0), 0);
  const calculatedPercent = totalPages ? Math.round((Math.min(totalPages, readPageKeys.length) / totalPages) * 100) : numericPercent;
  const completed = rows.some((row) => row.completed === true || String(row.status || "").toLowerCase() === "completed")
    || calculatedPercent >= 100
    || numericPercent >= 100;
  return {
    ...latest,
    readPageKeys,
    pagesRead: Math.max(readPageKeys.length, ...rows.map((row) => Number(row.pagesRead || row.pages_read) || 0)),
    totalPages,
    progressPercent: completed ? 100 : Math.max(calculatedPercent, numericPercent),
    completed,
    status: completed ? "completed" : (readPageKeys.length || numericPercent > 0 ? "in_progress" : latest.status || "pending"),
    startedAt: rows.map((row) => row.startedAt || row.started_at).filter(Boolean).sort()[0] || null,
    completedAt: completed ? rows.map((row) => row.completedAt || row.completed_at).filter(Boolean).sort()[0] || null : null,
  };
}

function progressSummary(progress = {}, resource = {}) {
  const allowed = new Set(values(resource.readerPages).map((page) => page.key));
  const readKeys = cleanList(progress.readPageKeys || progress.read_page_keys).filter((key) => allowed.has(key));
  const legacyPercent = Math.max(0, Math.min(100, Number(progress.progressPercent || progress.progress_percent) || 0));
  const exactPercent = allowed.size ? Math.round((readKeys.length / allowed.size) * 100) : 0;
  const previouslyCompleted = progress.completed === true || String(progress.status || "").toLowerCase() === "completed";
  const completed = previouslyCompleted || allowed.size > 0 && readKeys.length === allowed.size;
  const percent = completed ? 100 : Math.max(exactPercent, legacyPercent);
  return {
    progress_percent: completed ? 100 : percent,
    pages_read: readKeys.length,
    total_pages: allowed.size,
    completed,
    last_page_key: cleanString(progress.lastPageKey || progress.last_page_key, 100) || null,
    last_pdf_page: positiveInteger(progress.lastPdfPage ?? progress.last_pdf_page),
    last_printed_page: progress.lastPrintedPage ?? progress.last_printed_page ?? null,
    updated_at: progress.updatedAt || progress.updated_at || null,
  };
}

function latestProgress(progressRows = [], resource = {}, assignment = null) {
  const assignmentId = cleanString(assignment?.id, 180);
  const rows = values(progressRows).filter((row) => progressMatchesResource(row, resource));
  const scoped = assignmentId
    ? rows.filter((row) => !row.assignmentId && !row.assignment_id || String(row.assignmentId || row.assignment_id) === assignmentId)
    : rows;
  return combineAylaLibraryProgressRows(scoped.length ? scoped : rows);
}

function latestAssignment(assignments = [], resource = {}) {
  return values(assignments).filter((row) => assignmentMatchesResource(row, resource))
    .sort((left, right) => timestamp(right.updatedAt || right.updated_at || right.createdAt || right.created_at)
      - timestamp(left.updatedAt || left.updated_at || left.createdAt || left.created_at))[0] || null;
}

function resourceBasePath(studentId, resourceId) {
  return `/api/ayla/students/${encodeURIComponent(String(studentId || ""))}/library/resources/${encodeURIComponent(String(resourceId || ""))}`;
}

function assignmentQuery(assignment = null) {
  return assignment?.id ? `?assignment_id=${encodeURIComponent(String(assignment.id))}` : "";
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeAylaHiddenSourceText(value = "", resource = {}, fallback = "", max = 240) {
  let text = cleanString(value, max);
  const hiddenTerms = [resource.bookTitle, resource.book_title, resource.sourceLabel, resource.source_label, resource.provider, resource.edition]
    .map((term) => cleanString(term, 240))
    .filter((term) => term.length >= 3)
    .sort((left, right) => right.length - left.length);
  for (const term of hiddenTerms) text = text.replace(new RegExp(escapeRegExp(term), "gi"), " ");
  text = text.replace(/[\s\u2013\u2014:|/\\-]+/g, " ").trim();
  return text || cleanString(fallback, max);
}

export function aylaLibraryStudentTitle(resource = {}) {
  const sourceVisible = resource.sourceLabelVisible === true && Boolean(resource.sourceLabel);
  if (sourceVisible) return resource.title;
  const safeTopic = sanitizeAylaHiddenSourceText(resource.topic, resource, "Approved reading");
  const topicFallback = cleanKey(safeTopic, "") !== cleanKey(resource.bookTitle || resource.book_title, "") ? safeTopic : "Approved reading";
  return sanitizeAylaHiddenSourceText(resource.title, resource, topicFallback) || "Approved reading";
}

export function aylaLibraryStudentPageRange(resource = {}) {
  const fallback = pageRangeLabel({
    pdfPageStart: resource.pdfPageStart ?? resource.pdf_page_start,
    pdfPageEnd: resource.pdfPageEnd ?? resource.pdf_page_end,
    printedPageStart: resource.printedPageStart ?? resource.printed_page_start,
    printedPageEnd: resource.printedPageEnd ?? resource.printed_page_end,
  }, values(resource.readerPages));
  if (resource.sourceLabelVisible === true && Boolean(resource.sourceLabel)) return resource.pageRange || resource.page_range || fallback;
  return sanitizeAylaHiddenSourceText(resource.pageRange || resource.page_range, resource, fallback, 120);
}

function aylaLibraryStudentSystem(resource = {}) {
  if (resource.sourceLabelVisible === true && Boolean(resource.sourceLabel)) return resource.system;
  return sanitizeAylaHiddenSourceText(resource.system, resource, "General");
}

function aylaLibraryStudentTopic(resource = {}) {
  if (resource.sourceLabelVisible === true && Boolean(resource.sourceLabel)) return resource.topic;
  return sanitizeAylaHiddenSourceText(resource.topic, resource, "General reading");
}

function aylaLibraryStudentSubtopics(resource = {}) {
  if (resource.sourceLabelVisible === true && Boolean(resource.sourceLabel)) return resource.subtopics;
  return cleanList(resource.subtopics).map((item) => sanitizeAylaHiddenSourceText(item, resource, "")).filter(Boolean);
}

export function sanitizeAylaLibraryResource(resource = {}, { studentId = "", progress = null, assignment = null } = {}) {
  const basePath = resourceBasePath(studentId, resource.id);
  const summary = progressSummary(progress || {}, resource);
  const firstPage = values(resource.readerPages)[0] || null;
  const query = assignmentQuery(assignment);
  const sourceVisible = resource.sourceLabelVisible === true && Boolean(resource.sourceLabel);
  const safeTitle = aylaLibraryStudentTitle(resource);
  const safePageRange = aylaLibraryStudentPageRange(resource);
  return {
    id: resource.id,
    type: resource.type,
    title: safeTitle,
    description: sourceVisible
      ? resource.description || ""
      : sanitizeAylaHiddenSourceText(resource.description, resource, "", 2000),
    exam_track_id: resource.examTrackId,
    exam_track: resource.examTrack,
    system: aylaLibraryStudentSystem(resource),
    topic: aylaLibraryStudentTopic(resource),
    subtopics: aylaLibraryStudentSubtopics(resource),
    book_title: sourceVisible ? resource.bookTitle : "AylaMed Reading",
    edition: sourceVisible ? resource.edition || "" : "",
    page_range: safePageRange,
    pdf_page_start: resource.pdfPageStart,
    pdf_page_end: resource.pdfPageEnd,
    printed_page_start: resource.printedPageStart,
    printed_page_end: resource.printedPageEnd,
    exact_reference: sourceVisible ? resource.exactReference || "" : "",
    source_label: resource.sourceLabel || null,
    estimated_minutes: resource.estimatedMinutes,
    reader: {
      mode: "page_turn",
      resource_path: `${basePath}${query}`,
      first_page_path: firstPage ? `${basePath}/pages/${pagePathKey(firstPage)}${query}` : null,
      first_page_key: firstPage?.key || null,
      page_count: resource.readerPageCount,
      continuous_pdf_scroll: false,
    },
    progress: summary,
    roadmap_assignment: assignment ? {
      id: assignment.id,
      date: assignment.scheduledDate || assignment.scheduled_date || null,
      status: assignment.status || "pending",
      title: sourceVisible
        ? assignment.title || null
        : `${summary.progress_percent > 0 && !summary.completed ? "Continue" : "Read"}: ${safeTitle}${safePageRange ? ` — ${safePageRange}` : ""}`,
    } : null,
  };
}

export function buildAylaLibraryReader(resourceInput = {}, {
  examTrack = null,
  studentId = "",
  progress = null,
  assignment = null,
} = {}) {
  const resource = normalizeAylaLibraryResource(resourceInput, { examTrack });
  if (!resource?.readerReady || !Array.isArray(resource.readerPages)) return null;
  const read = new Set(cleanList(progress?.readPageKeys || progress?.read_page_keys));
  const basePath = resourceBasePath(studentId, resource.id);
  const query = assignmentQuery(assignment);
  return {
    resource: sanitizeAylaLibraryResource(resource, { studentId, progress, assignment }),
    pages: resource.readerPages.map((page) => ({
      key: page.key,
      turn_number: page.turnNumber,
      pdf_page: page.pdfPage,
      printed_page: page.printedPage,
      heading: resource.sourceLabelVisible ? page.heading || "" : sanitizeAylaHiddenSourceText(page.heading, resource, ""),
      exact_reference: resource.sourceLabelVisible ? page.exactReference || resource.exactReference || "" : "",
      page_path: `${basePath}/pages/${pagePathKey(page)}${query}`,
      read: read.has(page.key),
    })),
    navigation: { mode: "page_turn", continuous_pdf_scroll: false },
  };
}

export function findAylaLibraryPage(resourceInput = {}, selector = "", { examTrack = null } = {}) {
  const resource = normalizeAylaLibraryResource(resourceInput, { examTrack });
  if (!resource?.readerReady || !Array.isArray(resource.readerPages)) return null;
  const wanted = cleanString(selector, 100).toLowerCase();
  const numeric = positiveInteger(wanted);
  return resource.readerPages.find((page) => {
    const pathKey = pagePathKey(page).toLowerCase();
    return wanted === String(page.key).toLowerCase()
      || wanted === pathKey
      || (numeric && (numeric === page.turnNumber || numeric === page.pdfPage));
  }) || null;
}

export function buildAylaLibraryPage(resourceInput = {}, selector = "", {
  examTrack = null,
  studentId = "",
  progress = null,
  assignment = null,
} = {}) {
  const resource = normalizeAylaLibraryResource(resourceInput, { examTrack });
  const page = findAylaLibraryPage(resource, selector, { examTrack });
  if (!page) return null;
  const index = resource.readerPages.findIndex((row) => row.key === page.key);
  const previous = index > 0 ? resource.readerPages[index - 1] : null;
  const next = index + 1 < resource.readerPages.length ? resource.readerPages[index + 1] : null;
  const read = new Set(cleanList(progress?.readPageKeys || progress?.read_page_keys));
  const basePath = resourceBasePath(studentId, resource.id);
  const query = assignmentQuery(assignment);
  const navigation = (target) => target ? {
    key: target.key,
    turn_number: target.turnNumber,
    pdf_page: target.pdfPage,
    printed_page: target.printedPage,
    page_path: `${basePath}/pages/${pagePathKey(target)}${query}`,
  } : null;
  return {
    resource: sanitizeAylaLibraryResource(resource, { studentId, progress, assignment }),
    page: {
      key: page.key,
      turn_number: page.turnNumber,
      pdf_page: page.pdfPage,
      printed_page: page.printedPage,
      heading: resource.sourceLabelVisible ? page.heading || "" : sanitizeAylaHiddenSourceText(page.heading, resource, ""),
      exact_reference: resource.sourceLabelVisible ? page.exactReference || resource.exactReference || "" : "",
      content: page.text,
      read: read.has(page.key),
    },
    navigation: {
      mode: "page_turn",
      previous: navigation(previous),
      next: navigation(next),
      at_start: !previous,
      at_end: !next,
      continuous_pdf_scroll: false,
    },
  };
}

export function buildAylaLibraryCatalog({
  resources = [],
  examTrack,
  studentId = "",
  progressRows = [],
  assignments = [],
  filters = {},
  limit = 200,
  offset = 0,
} = {}) {
  const available = normalizeAylaLibraryResources(resources, { examTrack });
  const system = cleanKey(filters.system || filters.system_key, "");
  const topic = cleanKey(filters.topic || filters.topic_key, "");
  const search = cleanString(filters.search || filters.q, 180).toLowerCase();
  const filtered = available.filter((resource) => {
    if (system && cleanKey(aylaLibraryStudentSystem(resource), "") !== system) return false;
    if (topic && cleanKey(aylaLibraryStudentTopic(resource), "") !== topic) return false;
    const visibleSource = resource.sourceLabelVisible ? `${resource.bookTitle} ${resource.edition} ${resource.sourceLabel || ""}` : "";
    const safeDescription = resource.sourceLabelVisible
      ? resource.description
      : sanitizeAylaHiddenSourceText(resource.description, resource, "", 2000);
    const safeSystem = aylaLibraryStudentSystem(resource);
    const safeTopic = aylaLibraryStudentTopic(resource);
    const safeSubtopics = aylaLibraryStudentSubtopics(resource).join(" ");
    if (search && !`${aylaLibraryStudentTitle(resource)} ${safeDescription} ${visibleSource} ${safeSystem} ${safeTopic} ${safeSubtopics}`.toLowerCase().includes(search)) return false;
    return true;
  });
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const serialized = page.map((resource) => {
    const assignment = latestAssignment(assignments, resource);
    return sanitizeAylaLibraryResource(resource, {
      studentId,
      assignment,
      progress: latestProgress(progressRows, resource, assignment),
    });
  });
  const books = new Map();
  for (const resource of serialized) {
    const key = resource.source_label
      ? `${cleanKey(resource.book_title)}:${cleanKey(resource.edition, "no-edition")}`
      : `internal:${cleanKey(resource.id)}`;
    const row = books.get(key) || {
      key,
      title: resource.book_title,
      edition: resource.edition,
      source_label: resource.source_label,
      systems: new Set(),
      topics: new Set(),
      resources: [],
    };
    if (resource.system) row.systems.add(resource.system);
    if (resource.topic) row.topics.add(resource.topic);
    row.resources.push(resource);
    books.set(key, row);
  }
  return {
    exam_track_id: normalizeAylaShellExamTrack(examTrack),
    exam_track: normalizeAylaRegistryExamTrack(examTrack),
    total: filtered.length,
    limit: safeLimit,
    offset: safeOffset,
    has_more: safeOffset + serialized.length < filtered.length,
    filters: { system: system || null, topic: topic || null, search: search || null },
    facets: {
      systems: [...new Set(available.map(aylaLibraryStudentSystem).filter(Boolean))].sort(),
      topics: [...new Set(available.map(aylaLibraryStudentTopic).filter(Boolean))].sort(),
      books: [...new Set(available.map((resource) => resource.sourceLabelVisible ? resource.bookTitle : "AylaMed Reading").filter(Boolean))].sort(),
    },
    continue_reading: serialized.filter((resource) => resource.progress.progress_percent > 0 && !resource.progress.completed),
    books: [...books.values()].map((row) => ({
      ...row,
      systems: [...row.systems].sort(),
      topics: [...row.topics].sort(),
      resource_count: row.resources.length,
    })),
    resources: serialized,
  };
}

export function selectAylaRoadmapReading({
  resources = [],
  examTrack,
  focusSystem = "",
  focusTopic = "",
  progressRows = [],
  reservedResourceIds = [],
  preferredResourceIds = [],
} = {}) {
  const reserved = new Set(cleanList(reservedResourceIds));
  const preferred = new Map(cleanList(preferredResourceIds).map((id, index) => [id, index]));
  const systemKey = cleanKey(focusSystem, "");
  const topicKey = cleanKey(focusTopic, "");
  const candidates = normalizeAylaLibraryResources(resources, { examTrack }).filter((resource) => !resource.aliasResourceIds.some((id) => reserved.has(id)))
    .map((resource) => {
      const progress = latestProgress(progressRows, resource);
      const summary = progressSummary(progress || {}, resource);
      const systemMatch = Boolean(systemKey && cleanKey(resource.system, "") === systemKey);
      const topicMatch = Boolean(topicKey && (!systemKey || systemMatch) && cleanKey(resource.topic, "") === topicKey);
      const preferenceIndex = resource.aliasResourceIds.map((id) => preferred.get(id)).find((index) => index !== undefined);
      const resume = !summary.completed && summary.progress_percent > 0;
      const score = (topicMatch ? 500 : systemMatch ? 250 : systemKey ? -1000 : 0)
        + (resume ? 120 : 0)
        + (preferenceIndex !== undefined ? Math.max(1, 100 - preferenceIndex) : 0)
        + Math.max(-100, Math.min(100, Number(resource.relevance) || 0));
      return { resource, progress, summary, systemMatch, topicMatch, resume, score };
    }).filter((row) => !row.summary.completed && (!systemKey || row.systemMatch || row.topicMatch))
    .sort((left, right) => right.score - left.score || String(left.resource.id).localeCompare(String(right.resource.id)));
  const selected = candidates[0] || null;
  if (!selected) return { resource: null, match_level: "none", resumed: false, reason: "no_verified_exact_page_reading_for_focus" };
  return {
    resource: selected.resource,
    match_level: selected.topicMatch ? "exact_topic" : selected.systemMatch ? "system" : "general",
    resumed: selected.resume,
    reason: selected.resume ? "resume_exact_page_reading" : "best_verified_exact_page_reading",
  };
}

function resolveIncomingPageKey(resource = {}, value = "") {
  const page = findAylaLibraryPage(resource, value, { examTrack: resource.examTrackId });
  return page?.key || null;
}

export function mergeAylaLibraryProgress(existing = {}, incoming = {}, resourceInput = {}, now = new Date()) {
  const resource = normalizeAylaLibraryResource(resourceInput, { examTrack: resourceInput.examTrackId || resourceInput.examTrack });
  if (!resource) throw new Error("Verified exact-page reading is required for progress updates");
  const pages = values(resource.readerPages);
  const allowed = new Set(pages.map((page) => page.key));
  const existingKeys = cleanList(existing.readPageKeys || existing.read_page_keys).filter((key) => allowed.has(key));
  const incomingKeys = cleanList(incoming.readPageKeys || incoming.read_page_keys).map((key) => resolveIncomingPageKey(resource, key) || key).filter((key) => allowed.has(key));
  const selector = incoming.pageKey || incoming.page_key || incoming.page || incoming.pdfPage || incoming.pdf_page;
  const selectedPage = selector ? findAylaLibraryPage(resource, selector, { examTrack: resource.examTrackId }) : null;
  const markRead = incoming.read === true || incoming.markRead === true || incoming.mark_read === true || incoming.completed === true;
  const readPageKeys = [...new Set([...existingKeys, ...incomingKeys, ...(markRead && selectedPage ? [selectedPage.key] : [])])];
  const previouslyCompleted = existing.completed === true || String(existing.status || "").toLowerCase() === "completed";
  const completed = previouslyCompleted || allowed.size > 0 && readPageKeys.length === allowed.size;
  const existingPercent = Math.max(0, Math.min(100, Number(existing.progressPercent || existing.progress_percent) || 0));
  const exactPercent = allowed.size ? Math.round((readPageKeys.length / allowed.size) * 100) : 0;
  const updatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const lastPage = selectedPage || pages.find((page) => page.key === (incoming.lastPageKey || incoming.last_page_key))
    || pages.find((page) => page.key === (existing.lastPageKey || existing.last_page_key)) || null;
  return {
    ...existing,
    ...incoming,
    readPageKeys,
    pagesRead: readPageKeys.length,
    totalPages: allowed.size,
    progressPercent: completed ? 100 : Math.max(existingPercent, exactPercent),
    completed,
    status: completed ? "completed" : readPageKeys.length ? "in_progress" : "pending",
    lastPageKey: lastPage?.key || null,
    lastPdfPage: lastPage?.pdfPage || null,
    lastPrintedPage: lastPage?.printedPage || null,
    startedAt: existing.startedAt || existing.started_at || incoming.startedAt || incoming.started_at || updatedAt,
    completedAt: completed ? existing.completedAt || existing.completed_at || incoming.completedAt || incoming.completed_at || updatedAt : null,
    updatedAt,
  };
}

function mergeStoredProgress(older = {}, newer = {}) {
  const readPageKeys = [...new Set([
    ...cleanList(older.readPageKeys || older.read_page_keys),
    ...cleanList(newer.readPageKeys || newer.read_page_keys),
  ])];
  const totalPages = Math.max(Number(older.totalPages || older.total_pages) || 0, Number(newer.totalPages || newer.total_pages) || 0);
  const numericPercent = Math.max(Number(older.progressPercent || older.progress_percent) || 0, Number(newer.progressPercent || newer.progress_percent) || 0);
  const calculated = totalPages ? Math.round((Math.min(totalPages, readPageKeys.length) / totalPages) * 100) : numericPercent;
  const completed = older.completed === true || newer.completed === true || calculated >= 100 || numericPercent >= 100;
  return {
    ...older,
    ...newer,
    readPageKeys,
    pagesRead: Math.max(readPageKeys.length, Number(older.pagesRead || older.pages_read) || 0, Number(newer.pagesRead || newer.pages_read) || 0),
    totalPages,
    progressPercent: completed ? 100 : Math.max(calculated, numericPercent),
    completed,
    status: completed ? "completed" : (readPageKeys.length || numericPercent > 0 ? "in_progress" : newer.status || older.status || "pending"),
    startedAt: older.startedAt || older.started_at || newer.startedAt || newer.started_at || null,
    completedAt: completed ? older.completedAt || older.completed_at || newer.completedAt || newer.completed_at || null : null,
  };
}

export function mergeAylaLibraryProgressCollection(latest = {}, incoming = {}) {
  const combined = new Map();
  for (const row of [...values(latest), ...values(incoming)]) {
    if (!row?.id && !(row?.studentId || row?.student_id) && !(row?.resourceId || row?.resource_id)) continue;
    const key = row.id
      ? `id:${row.id}`
      : `${row.studentId || row.student_id || ""}|${row.resourceId || row.resource_id || ""}|${row.assignmentId || row.assignment_id || "library"}`;
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, { ...row });
      continue;
    }
    const newer = timestamp(row.updatedAt || row.updated_at) >= timestamp(existing.updatedAt || existing.updated_at) ? row : existing;
    const older = newer === row ? existing : row;
    combined.set(key, mergeStoredProgress(older, newer));
  }
  return Object.fromEntries([...combined.values()].map((row) => [String(row.id || `${row.studentId || row.student_id}:${row.resourceId || row.resource_id}:${row.assignmentId || row.assignment_id || "library"}`), row]));
}

export function aylaLibraryAssignmentProgress(assignment = {}, progressRows = []) {
  const assignmentId = cleanString(assignment.id, 180);
  const resourceIds = [...new Set([
    ...cleanList(assignment.resourceIds || assignment.resource_ids),
    ...values(assignment.items).map((item) => cleanString(item?.resourceId || item?.resource_id, 180)).filter(Boolean),
  ])];
  const resources = resourceIds.map((resourceId) => {
    const rows = values(progressRows).filter((row) => {
      const rowAssignmentId = cleanString(row.assignmentId || row.assignment_id, 180);
      const assignmentMatches = !rowAssignmentId || !assignmentId || rowAssignmentId === assignmentId;
      return assignmentMatches && String(row.resourceId || row.resource_id || "") === resourceId;
    });
    const combined = combineAylaLibraryProgressRows(rows) || {};
    const progressPercent = Number(combined.progressPercent || combined.progress_percent) || 0;
    const completed = combined.completed === true || progressPercent >= 100 || String(combined.status || "").toLowerCase() === "completed";
    return { resource_id: resourceId, progress_percent: completed ? 100 : Math.max(0, Math.min(100, progressPercent)), completed };
  });
  const progressPercent = resources.length ? Math.round(resources.reduce((sum, row) => sum + row.progress_percent, 0) / resources.length) : 0;
  return {
    resource_count: resources.length,
    progress_percent: progressPercent,
    completed: resources.length > 0 && resources.every((row) => row.completed),
    resources,
  };
}
