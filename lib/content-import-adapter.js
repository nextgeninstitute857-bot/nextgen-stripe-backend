import crypto from "node:crypto";
import path from "node:path";

export const CONTENT_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "gif", "webp"]);
export const CONTENT_VIDEO_EXTENSIONS = Object.freeze(["mp4", "mov", "m4v", "webm"]);
export const CONTENT_AUDIO_EXTENSIONS = Object.freeze(["mp3", "wav", "m4a", "aac", "ogg", "oga"]);
const CONTENT_MEDIA_EXTENSIONS = new Set([
  ...CONTENT_IMAGE_EXTENSIONS,
  ...CONTENT_VIDEO_EXTENSIONS,
  ...CONTENT_AUDIO_EXTENSIONS,
]);
const CONTENT_MEDIA_EXTENSION_PATTERN = [...CONTENT_MEDIA_EXTENSIONS].join("|");

export function slug(value, fallback = "unknown") {
  const clean = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || fallback;
}

export function normalizeExamTrack(value) {
  const aliases = {
    "step-1": "usmle-step-1", step1: "usmle-step-1", usmlestep1: "usmle-step-1", usmle_step_1: "usmle-step-1",
    "step-2": "usmle-step-2", "step-2-ck": "usmle-step-2", step2: "usmle-step-2", step2ck: "usmle-step-2",
    usmlestep2: "usmle-step-2", "usmle-step-2-ck": "usmle-step-2", usmle_step_2: "usmle-step-2", usmle_step_2_ck: "usmle-step-2",
    "step-3": "usmle-step-3", step3: "usmle-step-3", usmlestep3: "usmle-step-3", usmle_step_3: "usmle-step-3",
  };
  const clean = slug(value);
  return aliases[clean] || clean;
}

export function normalizeHtmlText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function decodedArchivePath(value) {
  let clean = String(value || "").trim()
    .replace(/^[([{]+|[\])}.!?]+$/g, "")
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/");
  if (!clean || /^data:/i.test(clean)) return { value: "", absolute: false };
  try { clean = decodeURIComponent(clean); } catch { /* Keep the original safe token. */ }
  let absolute = clean.startsWith("/");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
    try { clean = new URL(clean).pathname; } catch { return { value: "", absolute: false }; }
    try { clean = decodeURIComponent(clean); } catch { /* Keep the URL pathname. */ }
    absolute = true;
  }
  return {
    value: clean.replace(/\\/g, "/"),
    absolute,
  };
}

function archivePath(value) {
  const decoded = decodedArchivePath(value);
  const clean = decoded.value.replace(/^\/+/, "");
  const parts = [];
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function normalizeMediaReferencePath(value) {
  const clean = archivePath(value);
  const extension = path.extname(path.basename(clean)).slice(1).toLowerCase();
  return clean && CONTENT_MEDIA_EXTENSIONS.has(extension) ? clean : "";
}

export function mediaReferencePathCandidates(value, { sourceFile = "" } = {}) {
  const reference = normalizeMediaReferencePath(value);
  if (!reference) return [];
  const candidates = [];
  const source = archivePath(sourceFile);
  const sourceDirectory = source ? path.posix.dirname(source) : "";
  const decodedReference = decodedArchivePath(value);
  if (sourceDirectory && sourceDirectory !== "." && !decodedReference.absolute) {
    const resolved = archivePath(path.posix.join(sourceDirectory, decodedReference.value));
    if (resolved) candidates.push(resolved);
  }
  candidates.push(reference);
  return [...new Set(candidates)];
}

export function extractMediaReferences(...values) {
  const found = new Set();
  for (const value of values) {
    const text = String(value || "");
    const candidates = [];
    for (const match of text.matchAll(/(?:src|href|data-src)\s*=\s*["']([^"']+)["']/gi)) {
      candidates.push(match[1]);
    }
    const inlinePattern = new RegExp(
      `(?:^|[\\s,;|('"=])([^\\s,;|<>"']+\\.(?:${CONTENT_MEDIA_EXTENSION_PATTERN})(?:[?#][^\\s,;|<>"']*)?)`,
      "gi",
    );
    for (const match of text.matchAll(inlinePattern)) candidates.push(match[1]);
    for (const candidate of candidates) {
      const reference = normalizeMediaReferencePath(candidate);
      if (reference) found.add(reference);
    }
  }
  return [...found];
}

export function mediaMatchKeys(filename) {
  const base = path.basename(String(filename || "")).toLowerCase();
  const variants = new Set([base, base.replace(/^highresdefault_/, "")]);
  const keys = new Set(variants);
  for (const variant of variants) {
    let current = variant;
    for (let i = 0; i < 3; i += 1) {
      const next = current.replace(/\.(png|jpe?g|gif|webp|mp4|mov|m4v|webm|mp3|wav|m4a|aac|ogg|oga)$/i, "");
      if (next === current) break;
      keys.add(next);
      current = next;
    }
  }
  return [...keys];
}

const SOURCE_MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
});

export function sourceSnapshotRank(filename) {
  const base = path.basename(String(filename || "")).toLowerCase();
  const yearMatch = base.match(/(20\d{2})/);
  const year = Number(yearMatch?.[1] || 0);
  if (!year) return 0;
  const monthMatch = Object.entries(SOURCE_MONTHS).find(([name]) => new RegExp(`(?:^|[^a-z])${name}(?:[^a-z]|$)`, "i").test(base));
  const month = monthMatch ? monthMatch[1] : 0;
  const preferredEdition = /(?:^|[-_])new(?:[-_.]|$)/i.test(base) ? 2 : 0;
  const primaryCollection = /(?:^|[-_])sim\d*(?:[-_.]|$)/i.test(base) ? 0 : 1;
  return year * 10_000 + month * 100 + preferredEdition * 10 + primaryCollection;
}

export function contentHash({ questionHtml, answers = [] }) {
  const normalizedAnswers = answers
    .map((answer) => `${Number(answer.answerId || answer.answer_id || 0)}:${normalizeHtmlText(answer.answerText || answer.text)}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256")
    .update(`${normalizeHtmlText(questionHtml)}\n${normalizedAnswers}`)
    .digest("hex");
}

export function pairQuestionAnswerFiles(names = []) {
  const files = names.filter((name) => /\.json$/i.test(name));
  const questions = files.filter((name) => /_questions\.json$/i.test(name));
  return questions.map((questionFile, sourceIndex) => {
    const stem = questionFile.replace(/_questions\.json$/i, "");
    const answerFile = files.find((name) => name.toLowerCase() === `${stem}_answers.json`.toLowerCase()) || null;
    return { collectionKey: slug(path.basename(stem)), questionFile, answerFile, sourceIndex, sourceRank: sourceSnapshotRank(questionFile) };
  }).sort((a, b) => b.sourceRank - a.sourceRank || a.sourceIndex - b.sourceIndex);
}

export function adaptUniversalQuestion(question, answers, context = {}) {
  const sourceItemId = String(question.id ?? question.qId ?? question.questionId ?? "").trim();
  const sortedAnswers = [...answers].sort((a, b) => Number(a.answerId || 0) - Number(b.answerId || 0));
  const correctAnswerId = Number(question.corrAns ?? question.correctAnswerId ?? question.correct_answer_id);
  const questionMedia = extractMediaReferences(question.question);
  const explanationMedia = extractMediaReferences(question.explanation);
  const supplementalMedia = extractMediaReferences(question.otherMedias, question.mediaName);
  const preferredMedia = new Map();
  const considerMedia = (name, placement, priority) => {
    const matchPaths = mediaReferencePathCandidates(name, { sourceFile: context.sourceFile });
    const preferredPath = matchPaths[0] || String(name);
    const directory = preferredPath.includes("/") ? path.posix.dirname(preferredPath).toLowerCase() : "";
    const semanticName = mediaMatchKeys(name).at(-1) || String(name).toLowerCase();
    const semanticKey = directory ? `${directory}\u0000${semanticName}` : semanticName;
    const score = priority + (/^highresdefault_/i.test(path.basename(name)) ? 10 : 0);
    const current = preferredMedia.get(semanticKey);
    if (!current || score > current.score) {
      preferredMedia.set(semanticKey, {
        name,
        placement,
        score,
        matchPaths,
      });
    }
  };
  questionMedia.forEach((name) => considerMedia(name, "question", 100));
  explanationMedia.forEach((name) => considerMedia(name, "explanation", 80));
  supplementalMedia.forEach((name) => considerMedia(name, "explanation", 20));
  const media = [...preferredMedia.values()].map((item) => item.name);
  const mediaPlacements = Object.fromEntries([...preferredMedia.values()].map((item) => [item.name, item.placement]));
  const mediaMatchPaths = Object.fromEntries(
    [...preferredMedia.values()].map((item) => [item.name, item.matchPaths]),
  );
  return {
    examTrack: normalizeExamTrack(context.examTrack),
    sourceNamespace: slug(context.sourceNamespace),
    sourceProvider: String(context.sourceProvider || "unknown").trim(),
    collectionKey: slug(context.collectionKey),
    collectionTitle: String(context.collectionTitle || context.collectionKey || "Untitled collection").trim(),
    sourceItemId,
    title: String(question.title || "").trim(),
    questionHtml: String(question.question || question.stem || "").trim(),
    explanationHtml: String(question.explanation || "").trim(),
    correctAnswerId,
    answers: sortedAnswers.map((answer) => ({
      sourceId: String(answer.id ?? ""),
      answerId: Number(answer.answerId ?? answer.id),
      textHtml: String(answer.answerText || answer.text || "").trim(),
      correctPercentage: Number(answer.correctPercentage || 0),
    })),
    systemSourceId: String(question.sysId ?? ""),
    subjectSourceId: String(question.subId ?? ""),
    parentSourceId: String(question.parentQId ?? ""),
    media,
    statistics: {
      peopleTaken: Number(question.pplTaken || 0),
      correctTaken: Number(question.corrTaken || 0),
    },
    sourceUpdatedAt: String(question.lastUpdated || "").trim(),
    sourceData: {
      questionType: question.questionType ?? null,
      questionFormatType: question.questionFormatType ?? null,
      source_file: String(context.sourceFile || ""),
      source_rank: Number(context.sourceRank || 0),
      media_placements: mediaPlacements,
      media_match_paths: mediaMatchPaths,
    },
    contentHash: contentHash({ questionHtml: question.question || question.stem, answers: sortedAnswers }),
  };
}

export function validateAdaptedQuestion(row) {
  const errors = [];
  if (!row.sourceItemId) errors.push("missing_source_item_id");
  if (!normalizeHtmlText(row.questionHtml)) errors.push("missing_question_stem");
  if (row.answers.length < 2) errors.push("fewer_than_two_answers");
  if (!row.answers.some((answer) => answer.answerId === row.correctAnswerId)) errors.push("correct_answer_not_found");
  if (!normalizeHtmlText(row.explanationHtml)) errors.push("missing_explanation");
  return errors;
}
