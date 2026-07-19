const REGISTRY_CARD_PREFIX = "registry-question:";

export function normalizeCourseExamTrack(...values) {
  for (const value of values.flat()) {
    const clean = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!clean) continue;
    if (/(^|-)usmle(-)?step(-)?1($|-)|(^|-)step(-)?1($|-)/.test(clean)) return "usmle-step-1";
    if (/(^|-)usmle(-)?step(-)?2($|-)|(^|-)step(-)?2($|-)/.test(clean)) return "usmle-step-2";
    if (/(^|-)usmle(-)?step(-)?3($|-)|(^|-)step(-)?3($|-)/.test(clean)) return "usmle-step-3";
    if (clean.includes("nclex")) return "nclex";
    if (clean.includes("mccqe")) return "mccqe";
    if (/(^|-)amc($|-)/.test(clean)) return "amc";
    if (/(^|-)plab($|-)/.test(clean)) return "plab";
  }
  return "unknown";
}

export function contentRegistryFlashcardId(questionId = "") {
  const clean = String(questionId || "").trim();
  if (!clean) throw Object.assign(new Error("question_id is required"), { statusCode: 400 });
  return `${REGISTRY_CARD_PREFIX}${clean}`;
}

export function contentRegistryQuestionId(cardId = "") {
  const clean = String(cardId || "").trim();
  return clean.startsWith(REGISTRY_CARD_PREFIX) ? clean.slice(REGISTRY_CARD_PREFIX.length) : "";
}

export function registryQuestionToFlashcard(question = {}, { courseId = "", reviewed = false } = {}) {
  const id = contentRegistryFlashcardId(question.id);
  return {
    id,
    registry_question_id: String(question.id),
    course_id: String(courseId || ""),
    exam_track: String(question.exam_track || ""),
    student_qid: String(question.student_qid || ""),
    front: String(question.question_html || ""),
    back: String(question.correct_answer_html || ""),
    explanation: String(question.explanation_html || ""),
    system: String(question.system_key || question.taxonomy?.system_key || "unclassified"),
    subsystem: String(question.subsystem_key || question.taxonomy?.subsystem_key || "unclassified"),
    topic: String(question.topic_key || question.taxonomy?.topic_key || question.title || "unclassified"),
    subtopic: String(question.subtopic_key || question.taxonomy?.subtopic_key || ""),
    tag: String(question.topic_key || question.taxonomy?.topic_key || question.title || "QBank"),
    media: Array.isArray(question.media) ? question.media : [],
    videos: Array.isArray(question.videos) ? question.videos : [],
    source: "content_registry_mcq",
    source_label: "Official QBank",
    scope: "published_bank",
    bucket: "published_bank",
    read_only: true,
    answer_mode: "reveal_only",
    choices: [],
    reviewed: Boolean(reviewed),
  };
}
