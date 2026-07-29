import crypto from "node:crypto";

const SOURCE_KINDS = new Set([
  "library_page",
  "content_video",
  "qbank_question",
  "assessment_question",
  "roadmap_question",
  "revision_item",
]);

const SOURCE_BLOCK_TYPES = Object.freeze({
  library_page: "book_source",
  content_video: "video_clip",
  qbank_question: "question_source",
  assessment_question: "question_source",
  roadmap_question: "question_source",
  revision_item: "question_source",
});

function cleanString(value = "", max = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanList(value, max = 30) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(rows.map((item) => cleanString(item, 180)).filter(Boolean))].slice(0, max);
}

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

function positiveNumber(value, fallback = 0, max = 24 * 60 * 60) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, parsed)) : fallback;
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeSegment(value = "", max = 180) {
  return encodeURIComponent(cleanString(value, max));
}

function withQuery(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  return query.size ? `${path}?${query.toString()}` : path;
}

export function normalizeAylaNotebookSourceKind(value = "", blockType = "") {
  const clean = cleanString(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    book: "library_page",
    book_page: "library_page",
    reading: "library_page",
    library: "library_page",
    library_page: "library_page",
    video: "content_video",
    video_clip: "content_video",
    vimeo: "content_video",
    vimeo_video: "content_video",
    content_hub: "content_video",
    content_video: "content_video",
    question: "qbank_question",
    qbank: "qbank_question",
    qbank_question: "qbank_question",
    assessment: "assessment_question",
    assessment_question: "assessment_question",
    roadmap_question: "roadmap_question",
    assignment_question: "roadmap_question",
    revision: "revision_item",
    revision_item: "revision_item",
  };
  if (SOURCE_KINDS.has(aliases[clean])) return aliases[clean];
  const type = cleanString(blockType, 80).toLowerCase();
  if (type === "book_source") return "library_page";
  if (type === "video_clip") return "content_video";
  if (type === "question_source") return "qbank_question";
  return null;
}

export function aylaNotebookTimestampSeconds(value, { durationSeconds = 0 } = {}) {
  let parsed = null;
  if (typeof value === "number") parsed = value;
  else {
    const clean = cleanString(value, 80);
    if (/^\d+(?:\.\d+)?$/.test(clean)) parsed = Number(clean);
    else if (/^\d{1,3}:\d{1,2}(?::\d{1,2})?$/.test(clean)) {
      const parts = clean.split(":").map(Number);
      parsed = parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    }
  }
  const maximum = positiveNumber(durationSeconds, 0, 24 * 60 * 60) || 24 * 60 * 60;
  return Math.round(positiveNumber(parsed, 0, maximum));
}

export function aylaNotebookTimestampLabel(value) {
  const seconds = aylaNotebookTimestampSeconds(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function plainTextFromAylaNotebookHtml(value = "", max = 12000) {
  return cleanString(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n"), max);
}

export function selectAylaNotebookSourceExcerpt(canonicalText = "", requestedExcerpt = "", max = 6000) {
  const canonical = plainTextFromAylaNotebookHtml(canonicalText, 60000);
  const requested = plainTextFromAylaNotebookHtml(requestedExcerpt, max);
  if (!canonical) return requested ? null : "";
  if (!requested) return canonical.slice(0, max);
  const normalizedCanonical = canonical.replace(/\s+/g, " ").trim().toLowerCase();
  const normalizedRequested = requested.replace(/\s+/g, " ").trim().toLowerCase();
  return normalizedRequested && normalizedCanonical.includes(normalizedRequested) ? requested : null;
}

export function buildAylaNotebookDeepLink(input = {}) {
  const kind = normalizeAylaNotebookSourceKind(input.kind || input.sourceKind || input.sourceType, input.type);
  if (!kind) return null;
  const resourceId = cleanString(input.resourceId || input.resource_id, 180);
  const assignmentId = cleanString(input.assignmentId || input.assignment_id, 180);
  if (kind === "library_page") {
    const pageKey = cleanString(input.pageKey || input.page_key, 100);
    if (!resourceId || !pageKey) return null;
    const path = `/dashboard/library/${safeSegment(resourceId)}/page/${safeSegment(pageKey, 100)}`;
    return {
      surface: "library",
      label: "Return to this page",
      href: withQuery(path, { assignment: assignmentId }),
    };
  }
  if (kind === "content_video") {
    if (!resourceId) return null;
    const seconds = aylaNotebookTimestampSeconds(input.timestampSeconds ?? input.timestamp_seconds ?? input.startSeconds ?? input.start_seconds, {
      durationSeconds: input.durationSeconds || input.duration_seconds,
    });
    const path = `/dashboard/content-hub/${safeSegment(resourceId)}`;
    return {
      surface: "content_hub",
      label: seconds ? `Return to ${aylaNotebookTimestampLabel(seconds)}` : "Return to this video",
      href: withQuery(path, { t: seconds || null, assignment: assignmentId }),
    };
  }
  if (kind === "qbank_question") {
    const sessionId = cleanString(input.sessionId || input.session_id, 180);
    const questionRef = cleanString(input.questionRef || input.question_ref, 180);
    if (!sessionId || !questionRef) return null;
    return {
      surface: "qbank",
      label: "Return to this question",
      href: withQuery(`/dashboard/qbank/session/${safeSegment(sessionId)}`, {
        question: questionRef,
      }),
    };
  }
  if (kind === "assessment_question") {
    const assessmentId = cleanString(input.assessmentId || input.assessment_id || assignmentId, 180);
    const attemptId = cleanString(input.attemptId || input.attempt_id, 180);
    const questionRef = cleanString(input.questionRef || input.question_ref || input.questionId || input.question_id, 180);
    if (!assessmentId || !attemptId || !questionRef) return null;
    return {
      surface: "assessments",
      label: "Return to assessment review",
      href: withQuery("/dashboard/assessments", {
        assessment: assessmentId,
        attempt: attemptId,
        question: questionRef,
      }),
    };
  }
  if (kind === "roadmap_question") {
    const questionRef = cleanString(input.questionRef || input.question_ref || input.questionId || input.question_id || resourceId, 180);
    if (!assignmentId || !questionRef) return null;
    return {
      surface: "roadmap",
      label: "Return to this roadmap question",
      href: withQuery("/dashboard/qbank", {
        assignment: assignmentId,
        question: questionRef,
      }),
    };
  }
  const revisionId = cleanString(input.revisionId || input.revision_id || input.sourceId || input.source_id, 180);
  if (!revisionId) return null;
  return {
    surface: "revision",
    label: "Return to this revision item",
    href: withQuery("/dashboard/revision", { item: revisionId }),
  };
}

export function aylaNotebookSourceFingerprint(source = {}, noteText = "") {
  const kind = normalizeAylaNotebookSourceKind(source.kind || source.sourceKind || source.sourceType, source.type) || "unknown";
  const identity = [
    kind,
    source.resourceId || source.resource_id,
    source.pageKey || source.page_key,
    source.assignmentId || source.assignment_id,
    source.sessionId || source.session_id,
    source.questionRef || source.question_ref,
    source.attemptId || source.attempt_id,
    source.revisionId || source.revision_id,
    aylaNotebookTimestampSeconds(source.timestampSeconds ?? source.timestamp_seconds),
    cleanString(source.captureSection || source.capture_section, 80),
    cleanString(source.excerpt || source.sourceExcerpt || source.source_excerpt, 6000),
    cleanString(noteText, 12000),
  ].map((value) => String(value || "")).join("\u001f");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function createAylaNotebookCaptureBlocks({
  source = {},
  noteText = "",
  noteColor = "navy",
  pageId = "page-1",
  captureKey = "",
  now = new Date(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  const kind = normalizeAylaNotebookSourceKind(source.kind || source.sourceKind || source.sourceType, source.type);
  if (!kind || source.available === false) throw new Error("A currently available notebook source is required");
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const sourceText = cleanString(source.excerpt || source.sourceExcerpt || source.source_excerpt, 6000);
  const resolvedCaptureKey = cleanString(captureKey, 180) || aylaNotebookSourceFingerprint(source, noteText);
  const commonSource = {
    kind,
    resourceId: cleanString(source.resourceId || source.resource_id, 180),
    assignmentId: cleanString(source.assignmentId || source.assignment_id, 180),
    pageKey: cleanString(source.pageKey || source.page_key, 100),
    pdfPage: positiveNumber(source.pdfPage ?? source.pdf_page, 0, 100000),
    printedPage: cleanString(source.printedPage || source.printed_page, 80),
    sessionId: cleanString(source.sessionId || source.session_id, 180),
    questionRef: cleanString(source.questionRef || source.question_ref, 180),
    assessmentId: cleanString(source.assessmentId || source.assessment_id, 180),
    attemptId: cleanString(source.attemptId || source.attempt_id, 180),
    revisionId: cleanString(source.revisionId || source.revision_id, 180),
    timestampSeconds: aylaNotebookTimestampSeconds(source.timestampSeconds ?? source.timestamp_seconds, {
      durationSeconds: source.durationSeconds || source.duration_seconds,
    }),
    durationSeconds: positiveNumber(source.durationSeconds || source.duration_seconds, 0, 24 * 60 * 60),
    providerVideoId: cleanString(source.providerVideoId || source.provider_video_id || source.vimeoId || source.vimeo_id, 180),
    captureSection: cleanString(source.captureSection || source.capture_section, 80),
    examTrackId: cleanString(source.examTrackId || source.exam_track_id, 120),
    capturedAt: createdAt,
  };
  const sourceBlock = {
    id: cleanString(idFactory(), 180),
    type: SOURCE_BLOCK_TYPES[kind],
    pageId: cleanString(pageId || "page-1", 180),
    order: 0,
    text: sourceText,
    number: 1,
    color: "navy",
    resourceId: commonSource.resourceId,
    sourceType: kind,
    sourceTitle: cleanString(source.title || source.sourceTitle || source.source_title || "Saved source", 300),
    sourceReference: cleanString(source.reference || source.sourceReference || source.source_reference, 500),
    pdfPage: commonSource.pdfPage,
    printedPage: commonSource.printedPage,
    questionNumber: cleanString(source.questionNumber || source.question_number, 120),
    startSeconds: commonSource.timestampSeconds,
    endSeconds: commonSource.timestampSeconds,
    caption: cleanString(source.caption || "", 500),
    contentOrigin: "approved_source",
    visualStyle: "clean",
    sourceState: "available",
    captureKey: resolvedCaptureKey,
    source: commonSource,
    createdAt,
    updatedAt: createdAt,
  };
  const blocks = [sourceBlock];
  const cleanNote = cleanString(noteText, 12000);
  if (cleanNote) {
    blocks.push({
      id: cleanString(idFactory(), 180),
      type: "text",
      pageId: cleanString(pageId || "page-1", 180),
      order: 1,
      text: cleanNote,
      number: 1,
      color: cleanString(noteColor || "navy", 30),
      resourceId: "",
      sourceType: "",
      sourceTitle: "",
      sourceReference: "",
      caption: "",
      contentOrigin: "student_authored",
      visualStyle: "handwriting",
      linkedCaptureKey: resolvedCaptureKey,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return { blocks, captureKey: resolvedCaptureKey };
}

export function sanitizeAylaNotebookBlock(block = {}, { currentSource = null } = {}) {
  const kind = normalizeAylaNotebookSourceKind(
    currentSource?.kind || block.source?.kind || block.sourceKind || block.sourceType,
    block.type,
  );
  const isSource = Boolean(kind);
  const available = !isSource || (Boolean(currentSource) && currentSource.available !== false);
  const source = isSource ? {
    ...(block.source && typeof block.source === "object" ? block.source : {}),
    ...(currentSource && typeof currentSource === "object" ? currentSource : {}),
    kind,
  } : null;
  const safe = {
    id: cleanString(block.id, 180),
    type: cleanString(block.type || "text", 80),
    pageId: cleanString(block.pageId || block.page_id || "page-1", 180),
    order: Math.max(0, Math.trunc(Number(block.order) || 0)),
    text: isSource && !available ? "" : cleanString(currentSource?.excerpt ?? block.text, 12000),
    number: Math.max(1, Math.trunc(Number(block.number) || 1)),
    color: cleanString(block.color || "navy", 30),
    caption: isSource && !available ? "" : cleanString(block.caption, 500),
    contentOrigin: isSource ? "approved_source" : "student_authored",
    visualStyle: isSource ? "clean" : cleanString(block.visualStyle || "handwriting", 40),
    sourceState: isSource ? (available ? "available" : "unavailable") : null,
    createdAt: block.createdAt || null,
    updatedAt: block.updatedAt || null,
  };
  if (!isSource) {
    const imageUrl = cleanString(block.imageUrl || block.image_url, 4000);
    const dataUrl = String(block.dataUrl || block.data_url || "");
    if (imageUrl) safe.imageUrl = imageUrl;
    if (dataUrl.startsWith("data:image/") && dataUrl.length <= 350000) safe.dataUrl = dataUrl;
    return safe;
  }
  safe.sourceType = kind;
  safe.sourceTitle = available ? cleanString(source.title || source.sourceTitle || block.sourceTitle || "Saved source", 300) : "Source unavailable";
  safe.sourceReference = available ? cleanString(source.reference || source.sourceReference || block.sourceReference, 500) : "";
  safe.resourceId = available && ["library_page", "content_video"].includes(kind)
    ? cleanString(source.resourceId || block.resourceId, 180)
    : "";
  safe.pageKey = available ? cleanString(source.pageKey, 100) : "";
  safe.pdfPage = available ? positiveNumber(source.pdfPage ?? block.pdfPage, 0, 100000) : 0;
  safe.printedPage = available ? cleanString(source.printedPage || block.printedPage, 80) : "";
  safe.questionNumber = available ? cleanString(source.questionNumber || block.questionNumber, 120) : "";
  safe.timestampSeconds = available ? aylaNotebookTimestampSeconds(source.timestampSeconds ?? block.startSeconds, {
    durationSeconds: source.durationSeconds,
  }) : 0;
  safe.timestampLabel = available && safe.timestampSeconds ? aylaNotebookTimestampLabel(safe.timestampSeconds) : "";
  safe.returnLink = available ? buildAylaNotebookDeepLink(source) : null;
  return safe;
}

export function sanitizeAylaNotebook(notebook = {}, { currentSources = {} } = {}) {
  const sourceMap = currentSources instanceof Map ? currentSources : new Map(Object.entries(currentSources || {}));
  return {
    id: cleanString(notebook.id, 180),
    studentId: cleanString(notebook.studentId || notebook.student_id, 180),
    examTrackId: cleanString(notebook.examTrackId || notebook.exam_track_id, 120),
    title: cleanString(notebook.title || "Untitled medical note", 240),
    system: cleanString(notebook.system || "General", 120),
    topic: cleanString(notebook.topic, 240),
    tags: cleanList(notebook.tags),
    paperStyle: cleanString(notebook.paperStyle || "ruled", 40),
    inkStyle: cleanString(notebook.inkStyle || "pen", 40),
    status: cleanString(notebook.status || (notebook.archivedAt ? "archived" : "active"), 40),
    currentVersion: Math.max(0, Math.trunc(Number(notebook.currentVersion) || 0)),
    archivedAt: notebook.archivedAt || null,
    createdAt: notebook.createdAt || null,
    updatedAt: notebook.updatedAt || null,
    blocks: values(notebook.blocks).map((block, index) => sanitizeAylaNotebookBlock(
      { ...block, order: index },
      { currentSource: sourceMap.get(String(block.id)) || null },
    )),
  };
}

export function mergeConcurrentAylaNotebookCollection(latest = {}, incoming = {}) {
  const currentRows = latest && typeof latest === "object" && !Array.isArray(latest) ? latest : {};
  const incomingRows = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...currentRows };
  for (const [id, row] of Object.entries(incomingRows)) {
    const current = merged[id];
    if (!current || timestamp(row.updatedAt || row.createdAt) >= timestamp(current.updatedAt || current.createdAt)) merged[id] = row;
  }
  return merged;
}
