import crypto from "node:crypto";
import path from "node:path";

export const CONTENT_IMAGE_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
export const CONTENT_VIDEO_EXTENSIONS = Object.freeze(["mp4", "mov", "m4v", "webm"]);
export const CONTENT_AUDIO_EXTENSIONS = Object.freeze(["mp3", "wav", "m4a", "aac", "ogg", "oga"]);
export const CONTENT_SOURCE_ADAPTERS = Object.freeze({
  universalSba: "universal_sba_v1",
  ambossSba: "amboss_sba_v1",
  canadaQbankSba: "canadaqbank_sba_v1",
  flatSystemSba: "flat_system_sba_v1",
  cdmSelfRating: "cdm_self_rating_v1",
});
const CONTENT_MEDIA_EXTENSIONS = new Set([
  ...CONTENT_IMAGE_EXTENSIONS,
  ...CONTENT_VIDEO_EXTENSIONS,
  ...CONTENT_AUDIO_EXTENSIONS,
]);
const CONTENT_MEDIA_EXTENSION_PATTERN = [...CONTENT_MEDIA_EXTENSIONS].join("|");
const CONTENT_SOURCE_ADAPTER_SET = new Set(Object.values(CONTENT_SOURCE_ADAPTERS));
const MAX_IMPORTED_HTML_LENGTH = 500_000;

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

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function recoverExternalAnchorHref(tag) {
  if (/\bhref\s*=/i.test(tag)) return tag;
  const openUrl = tag.match(/\bopen_url\(\s*[`'"](https?:\/\/[^`'"]+)[`'"]\s*\)/i);
  if (!openUrl) return tag;
  return tag.replace(/>$/, ` href="${escapeHtmlAttribute(openUrl[1])}">`);
}

/**
 * Provider exports contain useful formatting, but some also contain inline
 * onclick handlers copied from their original web application. Imported HTML
 * is treated as untrusted: executable elements, event handlers and active URL
 * schemes are removed before persistence while ordinary medical formatting and
 * local media references are preserved.
 */
export function sanitizeImportedHtml(value) {
  let html = String(value || "").slice(0, MAX_IMPORTED_HTML_LENGTH);
  html = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|form|input|textarea|select|option|meta|base|link)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|form|input|textarea|select|option|meta|base|link)\b[^>]*\/?>/gi, "")
    .replace(/<a\b[^>]*>/gi, recoverExternalAnchorHref)
    .replace(/<button\b[^>]*>/gi, "<strong>")
    .replace(/<\/button\s*>/gi, "</strong>")
    .replace(/<([a-z][a-z0-9]*)\b([^>]*\bid\s*=\s*["']hintdiv["'][^>]*)>/gi, (tag) =>
      tag.replace(/display\s*:\s*none\s*;?/gi, ""))
    .replace(/\s+on[a-z0-9_:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[\s\S]*?\2/gi, "")
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^\s>]*/gi, "")
    .replace(/\s+style\s*=\s*(["'])(?:(?!\1)[\s\S])*(?:expression\s*\(|javascript\s*:|vbscript\s*:|url\s*\(\s*["']?\s*(?:javascript|vbscript|data\s*:\s*text\/html))(?:(?!\1)[\s\S])*\1/gi, "")
    .replace(/<a\b([^>]*)\btarget\s*=\s*(["'])_blank\2([^>]*)>/gi, (tag, before, quote, after) => {
      if (/\brel\s*=/i.test(tag)) return tag;
      return `<a${before}target=${quote}_blank${quote}${after} rel="noopener noreferrer">`;
    });
  return html.trim();
}

function normalizedAnswerText(answer) {
  return normalizeHtmlText(answer?.answerText || answer?.text || "");
}

export function isCdmSelfRatingQuestion(question = {}, answers = []) {
  const optionLabels = answers.map(normalizedAnswerText).sort();
  const exactSelfRating = optionLabels.length === 2
    && optionLabels[0] === "i don't know this"
    && optionLabels[1] === "i know this";
  if (!exactSelfRating) return false;
  const html = `${question.question || ""}\n${question.explanation || ""}`;
  return /correct answer\(s\)|maximum number of allowed responses|cdm\s*(?:case)?/i.test(html);
}

function contentSourceFingerprint(context = {}) {
  return [
    context.sourceProvider,
    context.sourceNamespace,
    context.collectionKey,
    context.collectionTitle,
    context.sourceFile,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
}

/**
 * Provider names are not exam names: CanadaQBank and AMBOSS both serve more
 * than one examination. Only return a hint when the provider is exam-specific
 * or the collection/export metadata itself names an exam.
 */
export function resolveContentSourceExamHint(context = {}) {
  const provider = String(context.sourceProvider || "").trim().toLowerCase();
  const fingerprint = contentSourceFingerprint(context);
  if (/\bamedex\b|\bmplusx\b|\bmplus\s*x\b/.test(provider)) return "amc";
  if (/\baceqbank\b|\bace\s*qbank\b/.test(provider)) return "mccqe";
  if (/\bmccqe\b/.test(fingerprint)) return "mccqe";
  if (/\busmle[-_\s]*step[-_\s]*1\b|\busmlestep1\b|\bcqb[-_\s]*usmlestep1\b/.test(fingerprint)) {
    return "usmle-step-1";
  }
  if (/\busmle[-_\s]*step[-_\s]*2(?:[-_\s]*ck)?\b|\busmlestep2(?:ck)?\b/.test(fingerprint)) {
    return "usmle-step-2";
  }
  if (/\busmle[-_\s]*step[-_\s]*3\b|\busmlestep3\b/.test(fingerprint)) {
    return "usmle-step-3";
  }
  return "";
}

export function resolveContentSourceAdapter(context = {}, question = {}, answers = []) {
  const explicit = String(context.sourceAdapter || context.source_adapter || "").trim().toLowerCase();
  if (CONTENT_SOURCE_ADAPTER_SET.has(explicit)) return explicit;
  const fingerprint = contentSourceFingerprint(context);
  if (/\baceqbank\b.*\bcdm\b|\bcdm\b.*\baceqbank\b/.test(fingerprint)
    || isCdmSelfRatingQuestion(question, answers)) {
    return CONTENT_SOURCE_ADAPTERS.cdmSelfRating;
  }
  if (/\bamboss\b/.test(fingerprint)) return CONTENT_SOURCE_ADAPTERS.ambossSba;
  if (/\bcanada\s*qbank\b|\bcanadaqbank\b|\bcqb[-_\s]?usmle\b/.test(fingerprint)) {
    return CONTENT_SOURCE_ADAPTERS.canadaQbankSba;
  }
  if (/\bamedex\b|\bmplusx\b|\bmplus\s*x\b/.test(fingerprint)) {
    return CONTENT_SOURCE_ADAPTERS.flatSystemSba;
  }
  return CONTENT_SOURCE_ADAPTERS.universalSba;
}

function sourceId(value, { zeroIsEmpty = false } = {}) {
  const clean = String(value ?? "").trim();
  return zeroIsEmpty && clean === "0" ? "" : clean;
}

function sourceIdList(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== "0"))];
}

export function adaptSourceTaxonomy(question = {}, sourceAdapter = CONTENT_SOURCE_ADAPTERS.universalSba) {
  const rawSystemId = sourceId(question.sysId);
  const rawSubjectId = sourceId(question.subId);
  const rawSubjectIds = sourceIdList(question.subId);
  if (sourceAdapter === CONTENT_SOURCE_ADAPTERS.ambossSba) {
    return {
      systemSourceId: sourceId(question.sysId, { zeroIsEmpty: true }),
      subjectSourceId: "",
      sourceTagIds: rawSubjectIds,
      orientation: "system_with_multi_value_tags",
      rawSystemId,
      rawSubjectId,
    };
  }
  if (sourceAdapter === CONTENT_SOURCE_ADAPTERS.canadaQbankSba) {
    return {
      systemSourceId: sourceId(question.subId, { zeroIsEmpty: true }),
      subjectSourceId: "",
      sourceTagIds: sourceIdList(question.sysId),
      orientation: "subject_as_system_with_topic_ids",
      rawSystemId,
      rawSubjectId,
    };
  }
  if (sourceAdapter === CONTENT_SOURCE_ADAPTERS.flatSystemSba) {
    return {
      systemSourceId: sourceId(question.sysId, { zeroIsEmpty: true }),
      subjectSourceId: "",
      sourceTagIds: rawSubjectIds,
      orientation: "flat_system",
      rawSystemId,
      rawSubjectId,
    };
  }
  if (sourceAdapter === CONTENT_SOURCE_ADAPTERS.cdmSelfRating) {
    return {
      systemSourceId: "",
      subjectSourceId: "",
      sourceTagIds: [],
      orientation: "unclassified_case",
      rawSystemId,
      rawSubjectId,
    };
  }
  return {
    systemSourceId: rawSystemId,
    subjectSourceId: rawSubjectId,
    sourceTagIds: rawSubjectIds,
    orientation: "system_then_subject",
    rawSystemId,
    rawSubjectId,
  };
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
    const textWithoutMediaAttributes = text.replace(
      /(?:src|href|data-src)\s*=\s*(["'])([\s\S]*?)\1/gi,
      (attribute, quote, reference) => {
        candidates.push(reference);
        return " ";
      },
    );
    const inlinePattern = new RegExp(
      `(?:^|[\\s,;|('"=])([^\\s,;|<>"']+\\.(?:${CONTENT_MEDIA_EXTENSION_PATTERN})(?:[?#][^\\s,;|<>"']*)?)`,
      "gi",
    );
    for (const match of textWithoutMediaAttributes.matchAll(inlinePattern)) candidates.push(match[1]);
    for (const candidate of candidates) {
      const reference = normalizeMediaReferencePath(candidate);
      if (reference) found.add(reference);
    }
  }
  return [...found];
}

function decodeHtmlUrl(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/\\\//g, "/");
}

/**
 * Remote videos are reference metadata only. They are deliberately kept out of
 * the media upload list so an import cannot copy or publish a third-party video
 * merely because a provider explanation linked to it.
 */
export function extractExternalVideoReferences(...values) {
  const found = new Map();
  const add = (provider, providerId, placement, sourceUrl) => {
    const cleanId = String(providerId || "").trim();
    if (!cleanId) return;
    const key = `${provider}:${cleanId}`;
    const current = found.get(key);
    if (current && current.placement === "question") return;
    found.set(key, {
      provider,
      provider_id: cleanId,
      placement,
      source_url: sourceUrl,
      review_status: "private_unreviewed",
    });
  };
  for (const entry of values) {
    const value = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : { html: entry, placement: "explanation" };
    const text = decodeHtmlUrl(value.html);
    const placement = String(value.placement || "explanation");
    for (const match of text.matchAll(
      /(?:https?:)?\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^"'<> \s]*?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})[^"'<> \s]*/gi,
    )) {
      add("youtube", match[1], placement, `https://www.youtube.com/watch?v=${match[1]}`);
    }
    for (const match of text.matchAll(
      /(?:https?:)?\/\/(?:www\.)?(?:player\.)?vimeo\.com\/(?:video\/)?([0-9]{5,})[^"'<> \s]*/gi,
    )) {
      add("vimeo", match[1], placement, `https://vimeo.com/${match[1]}`);
    }
  }
  return [...found.values()];
}

export function mediaMatchKeys(filename) {
  const base = path.basename(String(filename || "")).toLowerCase();
  const variants = new Set([base, base.replace(/^highresdefault_/, "")]);
  const keys = new Set(variants);
  for (const variant of variants) {
    let current = variant;
    for (let i = 0; i < 3; i += 1) {
      const next = current.replace(/\.(png|jpe?g|gif|webp|bmp|mp4|mov|m4v|webm|mp3|wav|m4a|aac|ogg|oga)$/i, "");
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
  const sourceAdapter = resolveContentSourceAdapter(context, question, sortedAnswers);
  const sourceExamTrackHint = resolveContentSourceExamHint(context);
  const taxonomy = adaptSourceTaxonomy(question, sourceAdapter);
  const questionHtml = sanitizeImportedHtml(question.question || question.stem);
  const explanationHtml = sanitizeImportedHtml(question.explanation);
  const sanitizedAnswers = sortedAnswers.map((answer) => ({
    ...answer,
    answerText: sanitizeImportedHtml(answer.answerText || answer.text),
  }));
  const answerMedia = new Map();
  for (const answer of sanitizedAnswers) {
    const answerId = Number(answer.answerId ?? answer.id);
    answerMedia.set(answerId, extractMediaReferences(answer.answerText));
  }
  const questionMedia = extractMediaReferences(questionHtml);
  const explanationMedia = extractMediaReferences(explanationHtml);
  const supplementalMedia = extractMediaReferences(question.otherMedias, question.mediaName);
  const externalVideoReferences = extractExternalVideoReferences(
    { html: question.question || question.stem, placement: "question" },
    { html: question.explanation, placement: "explanation" },
    ...sortedAnswers.map((answer) => ({
      html: answer.answerText || answer.text,
      placement: `answer:${Number(answer.answerId ?? answer.id)}`,
    })),
  );
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
  for (const [answerId, references] of answerMedia.entries()) {
    references.forEach((name) => considerMedia(name, `answer:${answerId}`, 120));
  }
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
    questionHtml,
    explanationHtml,
    correctAnswerId,
    answers: sanitizedAnswers.map((answer) => ({
      sourceId: String(answer.id ?? ""),
      answerId: Number(answer.answerId ?? answer.id),
      textHtml: String(answer.answerText || "").trim(),
      correctPercentage: Number(answer.correctPercentage || 0),
      mediaRefs: answerMedia.get(Number(answer.answerId ?? answer.id)) || [],
    })),
    systemSourceId: taxonomy.systemSourceId,
    subjectSourceId: taxonomy.subjectSourceId,
    parentSourceId: String(question.parentQId ?? ""),
    media,
    statistics: {
      peopleTaken: Number(question.pplTaken || 0),
      correctTaken: Number(question.corrTaken || 0),
    },
    sourceUpdatedAt: String(question.lastUpdated || "").trim(),
    sourceData: {
      source_adapter: sourceAdapter,
      source_exam_track_hint: sourceExamTrackHint,
      item_format: sourceAdapter === CONTENT_SOURCE_ADAPTERS.cdmSelfRating
        ? "cdm_self_rating_case"
        : "single_best_answer",
      scoring_mode: sourceAdapter === CONTENT_SOURCE_ADAPTERS.cdmSelfRating
        ? "self_rating_not_mastery"
        : "correctness",
      source_taxonomy_orientation: taxonomy.orientation,
      source_system_id_raw: taxonomy.rawSystemId,
      source_subject_id_raw: taxonomy.rawSubjectId,
      source_tag_ids: taxonomy.sourceTagIds,
      questionType: question.questionType ?? null,
      questionFormatType: question.questionFormatType ?? null,
      source_file: String(context.sourceFile || ""),
      source_rank: Number(context.sourceRank || 0),
      media_placements: mediaPlacements,
      media_match_paths: mediaMatchPaths,
      external_video_references: externalVideoReferences,
    },
    contentHash: contentHash({ questionHtml, answers: sanitizedAnswers }),
  };
}

export function validateAdaptedQuestion(row) {
  const errors = [];
  if (!row.sourceItemId) errors.push("missing_source_item_id");
  if (!normalizeHtmlText(row.questionHtml)) errors.push("missing_question_stem");
  if (row.answers.length < 2) errors.push("fewer_than_two_answers");
  if (!row.answers.some((answer) => answer.answerId === row.correctAnswerId)) errors.push("correct_answer_not_found");
  if (!normalizeHtmlText(row.explanationHtml)) errors.push("missing_explanation");
  if (row.sourceData?.source_exam_track_hint
    && normalizeExamTrack(row.sourceData.source_exam_track_hint) !== normalizeExamTrack(row.examTrack)) {
    errors.push("source_exam_track_mismatch");
  }
  if (row.sourceData?.source_adapter === CONTENT_SOURCE_ADAPTERS.cdmSelfRating) {
    errors.push("specialized_cdm_interaction_required");
  }
  return errors;
}
