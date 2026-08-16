import { normalizeAylaLibraryResources } from "./aylamed-library.js";
import { normalizeAylaShellExamTrack } from "./aylamed-student-shell.js";

const MAX_RESULT_CONTENT = 6_000;

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

function cleanString(value = "", max = 500) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function tokens(value = "") {
  return [...new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2))];
}

function exactReference(resource = {}, page = {}) {
  return cleanString(
    page.exactReference
      || resource.exactReference
      || [resource.sourceLabel || resource.bookTitle, resource.edition, page.printedPage ? `p. ${page.printedPage}` : resource.pageRange]
        .filter(Boolean)
        .join(", "),
    500,
  );
}

function pageScore(resource = {}, page = {}, queryTokens = []) {
  if (!queryTokens.length) return Math.max(0, Number(resource.relevance) || 0);
  const title = `${resource.title || ""} ${resource.bookTitle || ""}`.toLowerCase();
  const taxonomy = `${resource.system || ""} ${resource.topic || ""} ${values(resource.subtopics).join(" ")}`.toLowerCase();
  const heading = String(page.heading || "").toLowerCase();
  const body = String(page.text || "").toLowerCase();
  let score = 0;
  let matched = 0;
  for (const token of queryTokens) {
    let tokenScore = 0;
    if (title.includes(token)) tokenScore += 14;
    if (taxonomy.includes(token)) tokenScore += 12;
    if (heading.includes(token)) tokenScore += 10;
    if (body.includes(token)) tokenScore += 3;
    if (tokenScore > 0) matched += 1;
    score += tokenScore;
  }
  if (!matched) return 0;
  score += Math.round((matched / queryTokens.length) * 20);
  score += Math.max(-20, Math.min(20, Number(resource.relevance) || 0));
  return score;
}

export function buildAylaLibraryGroundingIndex({ resources = [], examTrack = null } = {}) {
  const normalizedExamTrack = examTrack ? normalizeAylaShellExamTrack(examTrack) : null;
  if (examTrack && !normalizedExamTrack) return [];
  const normalized = normalizeAylaLibraryResources(resources, { examTrack: normalizedExamTrack });
  return normalized.flatMap((resource) => resource.readerPages.map((page) => ({
    id: `${resource.id}:${page.key}`,
    resourceId: resource.id,
    examTrackId: resource.examTrackId,
    title: page.heading || resource.title,
    documentTitle: resource.bookTitle,
    category: "AylaMed Exam Library",
    tags: [resource.examTrackId, resource.system, resource.topic, ...values(resource.subtopics)].filter(Boolean),
    content: String(page.text || "").slice(0, MAX_RESULT_CONTENT),
    resourceName: resource.sourceLabel || resource.bookTitle,
    topic: resource.topic,
    system: resource.system,
    pageRange: page.printedPage ? String(page.printedPage) : page.pdfPage ? `PDF ${page.pdfPage}` : resource.pageRange,
    pdfPage: page.pdfPage || null,
    printedPage: page.printedPage || null,
    pageKey: page.key,
    exactReference: exactReference(resource, page),
    sourceLabelVisible: resource.sourceLabelVisible === true,
    authorizationStatus: resource.authorizationStatus,
    verificationStatus: resource.verificationStatus,
    relevance: resource.relevance,
  })));
}

export function searchAylaLibraryGrounding({ resources = [], examTrack = null, query = "", limit = 8 } = {}) {
  const queryTokens = tokens(query);
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 8)));
  return buildAylaLibraryGroundingIndex({ resources, examTrack })
    .map((row) => ({ row, score: pageScore({
      title: row.title,
      bookTitle: row.documentTitle,
      system: row.system,
      topic: row.topic,
      subtopics: row.tags,
      relevance: row.relevance,
    }, { heading: row.title, text: row.content }, queryTokens) }))
    .filter(({ score }) => !queryTokens.length || score > 0)
    .sort((left, right) => right.score - left.score
      || String(left.row.documentTitle || "").localeCompare(String(right.row.documentTitle || ""))
      || String(left.row.pageKey || "").localeCompare(String(right.row.pageKey || "")))
    .slice(0, safeLimit)
    .map(({ row, score }) => ({
      id: row.id,
      resource_id: row.resourceId,
      exam_track_id: row.examTrackId,
      document_id: row.resourceId,
      document_title: row.documentTitle,
      title: row.title,
      category: row.category,
      tags: row.tags,
      content: row.content,
      structured: null,
      resource_name: row.resourceName,
      system: row.system,
      topic: row.topic,
      page_range: row.pageRange,
      pdf_page: row.pdfPage,
      printed_page: row.printedPage,
      page_key: row.pageKey,
      qids: [],
      video_url: null,
      video_title: null,
      timestamp: null,
      exact_reference: row.exactReference,
      reference_ready: Boolean(row.exactReference || row.pageRange),
      source: "AylaMed Exam Library",
      approval_status: "approved",
      score,
    }));
}

export function summarizeAylaLibraryGrounding({ resources = [] } = {}) {
  const normalized = normalizeAylaLibraryResources(resources);
  const perExam = {};
  for (const resource of normalized) {
    const exam = resource.examTrackId;
    const row = perExam[exam] || { exam_track_id: exam, resources: 0, pages: 0, books: new Set() };
    row.resources += 1;
    row.pages += resource.readerPageCount;
    row.books.add(resource.bookTitle);
    perExam[exam] = row;
  }
  const rows = Object.values(perExam).map((row) => ({
    exam_track_id: row.exam_track_id,
    resources: row.resources,
    pages: row.pages,
    books: row.books.size,
  })).sort((left, right) => left.exam_track_id.localeCompare(right.exam_track_id));
  return {
    eligible_items: rows.reduce((sum, row) => sum + row.pages, 0),
    eligible_documents: normalized.length,
    eligible_books: new Set(normalized.map((resource) => `${resource.examTrackId}:${resource.bookTitle}`)).size,
    per_exam: rows,
  };
}
