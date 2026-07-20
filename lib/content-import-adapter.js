import crypto from "node:crypto";
import path from "node:path";

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

export function extractMediaReferences(...values) {
  const found = new Set();
  for (const value of values) {
    const text = String(value || "");
    for (const match of text.matchAll(/(?:src\s*=\s*["']([^"']+)["'])/gi)) {
      const name = path.basename(String(match[1] || "").split(/[?#]/)[0]);
      if (name) found.add(name);
    }
    if (!text.includes("<")) {
      text.split(/[,;|]/).map((item) => path.basename(item.trim())).filter(Boolean).forEach((item) => found.add(item));
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
      const next = current.replace(/\.(png|jpe?g|gif|webp)$/i, "");
      if (next === current) break;
      keys.add(next);
      current = next;
    }
  }
  return [...keys];
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
  return questions.map((questionFile) => {
    const stem = questionFile.replace(/_questions\.json$/i, "");
    const answerFile = files.find((name) => name.toLowerCase() === `${stem}_answers.json`.toLowerCase()) || null;
    return { collectionKey: slug(path.basename(stem)), questionFile, answerFile };
  });
}

export function adaptUniversalQuestion(question, answers, context = {}) {
  const sourceItemId = String(question.id ?? question.qId ?? question.questionId ?? "").trim();
  const sortedAnswers = [...answers].sort((a, b) => Number(a.answerId || 0) - Number(b.answerId || 0));
  const correctAnswerId = Number(question.corrAns ?? question.correctAnswerId ?? question.correct_answer_id);
  const media = extractMediaReferences(question.question, question.explanation, question.otherMedias, question.mediaName);
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
