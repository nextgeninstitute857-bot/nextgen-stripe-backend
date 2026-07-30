import crypto from "node:crypto";
import {
  normalizeAylaRegistryExamTrack,
  normalizeAylaShellExamTrack,
} from "./aylamed-student-shell.js";
import { flashcardTextOnlyHtml } from "./flashcard-engine.js";

function cleanString(value = "", max = 12000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .slice(0, max);
}

function cleanList(values = [], max = 40) {
  const rows = Array.isArray(values) ? values : values ? [values] : [];
  return [...new Set(rows.map((value) => cleanString(value, 180)).filter(Boolean))].slice(0, max);
}

function firstValue(input = {}, keys = []) {
  for (const key of keys) {
    const value = input?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return "";
}

function answerText(answer = {}) {
  if (typeof answer === "string" || typeof answer === "number") return cleanString(answer, 8000);
  return cleanString(answer.text_html ?? answer.textHtml ?? answer.text ?? answer.label ?? answer.value, 8000);
}

function correctAnswerText(question = {}, explicitCorrectAnswer = "") {
  const explicit = answerText(explicitCorrectAnswer);
  if (explicit) return explicit;
  const answers = Array.isArray(question.answers) ? question.answers : [];
  const correctId = question.correct_answer_id ?? question.correctAnswerId ?? question.correctAnswer;
  const match = answers.find((answer) => String(answer?.answer_id ?? answer?.answerId ?? answer?.id) === String(correctId));
  if (match) return answerText(match);
  const options = Array.isArray(question.options) ? question.options : [];
  const explicitIndex = Number(question.correctAnswerIndex ?? question.correct_answer_index);
  if (Number.isInteger(explicitIndex) && explicitIndex >= 0 && explicitIndex < options.length) return answerText(options[explicitIndex]);
  return answerText(question.correct_answer_html ?? question.correctAnswerHtml);
}

export function aylaAdaptiveExamMetadata(input = {}) {
  const raw = typeof input === "string"
    ? input
    : firstValue(input, ["examTrackId", "exam_track_id", "examTrack", "exam_track", "exam"]);
  const examTrackId = normalizeAylaShellExamTrack(raw);
  return {
    examTrackId,
    examTrack: examTrackId ? normalizeAylaRegistryExamTrack(examTrackId) : null,
  };
}

/**
 * Fail closed when a row declares an invalid or conflicting exam. Legacy rows
 * with no exam field remain usable only inside the already-owned student ID.
 */
export function aylaAdaptiveEvidenceMatchesStudent(row = {}, student = {}, { verifiedOnly = false } = {}) {
  const studentId = String(student.id || student.studentId || student.student_id || "");
  const rowStudentId = String(row.studentId || row.student_id || "");
  if (!studentId || !rowStudentId || rowStudentId !== studentId) return false;
  if (verifiedOnly && row.serverVerified !== true) return false;

  const expected = aylaAdaptiveExamMetadata(student).examTrackId;
  if (!expected) return false;
  const declared = ["examTrackId", "exam_track_id", "examTrack", "exam_track", "exam"]
    .map((key) => row?.[key])
    .filter((value) => value !== undefined && value !== null && String(value).trim());
  if (!declared.length) return true;
  return declared.every((value) => normalizeAylaShellExamTrack(value) === expected);
}

export function aylaAdaptiveSystemsForStudent(student = {}, examRegistry = {}, fallbackSystems = []) {
  const { examTrackId } = aylaAdaptiveExamMetadata(student);
  const configured = examTrackId && Array.isArray(examRegistry?.[examTrackId]?.systems)
    ? examRegistry[examTrackId].systems
    : fallbackSystems;
  return cleanList(configured, 100);
}

export function aylaMistakeFlashcardId({ studentId = "", examTrack = "", sourceType = "", sourceIdentity = "" } = {}) {
  const examTrackId = normalizeAylaShellExamTrack(examTrack);
  const identity = [studentId, examTrackId, sourceType, sourceIdentity].map((value) => cleanString(value, 300)).join("|");
  if (!studentId || !examTrackId || !sourceType || !sourceIdentity) return null;
  return `AYLA-WEAK-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

/**
 * Build a private, owner-scoped recall card from a server-verified mistake.
 * The deterministic ID prevents duplicate cards when the same source question
 * is missed repeatedly.
 */
export function buildAylaMistakeFlashcard({
  student = {},
  examTrack = "",
  sourceType = "qbank_mistake",
  sourceIdentity = "",
  sourceSessionId = "",
  sourceQuestionRef = "",
  sourceAttemptId = "",
  question = {},
  correctAnswer = "",
  now = new Date().toISOString(),
} = {}) {
  const studentId = String(student.id || student.studentId || student.student_id || "");
  const exam = aylaAdaptiveExamMetadata(examTrack || student);
  const id = aylaMistakeFlashcardId({
    studentId,
    examTrack: exam.examTrackId,
    sourceType,
    sourceIdentity,
  });
  const front = cleanString(flashcardTextOnlyHtml(
    question.question_html ?? question.questionHtml ?? question.stem ?? question.question ?? question.title,
  ), 12000);
  const back = cleanString(flashcardTextOnlyHtml(correctAnswerText(question, correctAnswer)), 8000);
  if (!id || !front || !back) return null;

  const taxonomy = question.taxonomy && typeof question.taxonomy === "object" ? question.taxonomy : {};
  const system = cleanString(question.system_key ?? question.systemKey ?? taxonomy.system_key ?? taxonomy.systemKey ?? question.system ?? "General", 140) || "General";
  const subsystem = cleanString(question.subsystem_key ?? question.subsystemKey ?? taxonomy.subsystem_key ?? taxonomy.subsystemKey ?? question.subsystem, 180);
  const topic = cleanString(question.topic_key ?? question.topicKey ?? taxonomy.topic_key ?? taxonomy.topicKey ?? question.topic ?? question.title ?? system, 220) || system;
  const subtopic = cleanString(question.subtopic_key ?? question.subtopicKey ?? taxonomy.subtopic_key ?? taxonomy.subtopicKey ?? question.subtopic, 220);
  const explanation = cleanString(flashcardTextOnlyHtml(
    question.explanation_html ?? question.explanationHtml ?? question.explanation,
  ), 12000);

  return {
    id,
    type: "flashcard",
    bucket: "weak_area",
    ownerStudentId: studentId,
    studentId,
    examTrackId: exam.examTrackId,
    examTrack: exam.examTrack,
    title: `Weak-area recall: ${topic}`,
    resourceNumber: `WEAK-${id.slice(-12).toUpperCase()}`,
    system,
    subsystem,
    topic,
    subtopic,
    subtopics: cleanList([subtopic]),
    concepts: cleanList(question.concepts ?? taxonomy.concepts),
    front,
    back,
    explanation,
    priority: "Critical",
    estimatedMinutes: 1,
    approved: true,
    status: "active",
    authorizationStatus: "owned",
    verificationStatus: "server_verified_mistake",
    sourceAccessMode: "protected",
    sourceLabelVisible: false,
    sourceType,
    sourceIdentity: cleanString(sourceIdentity, 300),
    sourceQuestionId: cleanString(question.id || sourceIdentity, 300),
    sourceQuestionRef: cleanString(sourceQuestionRef, 300),
    sourceAttemptIds: cleanList([sourceAttemptId], 25),
    sourceSessionIds: cleanList([sourceSessionId], 25),
    deliveryDestinations: ["aylamed_private_student"],
    media: [],
    videos: [],
    mediaOmittedForFlashcard: true,
    mistakeCount: 1,
    lastMistakeAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeAylaMistakeFlashcard(existing = null, candidate = null) {
  if (!candidate) return null;
  if (!existing) return { ...candidate };
  if (String(existing.id || "") !== String(candidate.id || "")) {
    throw new Error("Cannot merge different AylaMed mistake flashcards");
  }
  return {
    ...existing,
    ...candidate,
    mistakeCount: Math.max(1, Number(existing.mistakeCount || 1)) + 1,
    sourceAttemptIds: cleanList([...(existing.sourceAttemptIds || []), ...(candidate.sourceAttemptIds || [])], 25),
    sourceSessionIds: cleanList([...(existing.sourceSessionIds || []), ...(candidate.sourceSessionIds || [])], 25),
    createdAt: existing.createdAt || candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}
