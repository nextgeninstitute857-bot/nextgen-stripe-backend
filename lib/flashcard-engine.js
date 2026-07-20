const DAY_MS = 24 * 60 * 60 * 1000;

export const FLASHCARD_APP_CAPABILITIES = Object.freeze({
  lms: Object.freeze({
    studentSourceCreation: false,
    // Official, admin-approved Content Registry questions may be presented as
    // read-only LMS cards. This does not allow students to create QBank cards.
    qbankSource: true,
    bookSource: false,
    videoTimestampSource: false,
    notebookSource: false,
    assessmentMistakeSource: false,
  }),
  aylamed: Object.freeze({
    studentSourceCreation: true,
    qbankSource: true,
    bookSource: true,
    videoTimestampSource: true,
    notebookSource: true,
    assessmentMistakeSource: true,
  }),
});

export function flashcardCapabilities(app = "") {
  return FLASHCARD_APP_CAPABILITIES[String(app).toLowerCase()] || Object.freeze({});
}

export function normalizeFlashcardRating(value = "") {
  const rating = String(value || "").trim().toLowerCase();
  if (["again", "hard", "good", "easy"].includes(rating)) return rating;
  if (["low", "poor", "incorrect", "wrong", "1"].includes(rating)) return "again";
  if (["medium", "unsure", "2"].includes(rating)) return "hard";
  if (["high", "correct", "3"].includes(rating)) return "good";
  if (["mastered", "very_high", "4", "5"].includes(rating)) return "easy";
  return "good";
}

function isoDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function scheduleFlashcardReview(previous = {}, ratingValue = "good", reviewedAt = new Date()) {
  const rating = normalizeFlashcardRating(ratingValue);
  const priorInterval = Math.max(0, Number(previous.interval_days ?? previous.intervalDays ?? 0) || 0);
  const priorEase = Math.min(3, Math.max(1.3, Number(previous.ease_factor ?? previous.easeFactor ?? 2.5) || 2.5));
  const priorLapses = Math.max(0, Number(previous.lapses || 0) || 0);
  let intervalDays;
  let easeFactor = priorEase;
  let lapses = priorLapses;

  if (rating === "again") {
    intervalDays = 1;
    easeFactor = Math.max(1.3, priorEase - 0.2);
    lapses += 1;
  } else if (rating === "hard") {
    intervalDays = priorInterval ? Math.max(2, Math.round(priorInterval * 1.2)) : 2;
    easeFactor = Math.max(1.3, priorEase - 0.15);
  } else if (rating === "easy") {
    intervalDays = priorInterval ? Math.max(7, Math.round(priorInterval * priorEase * 1.3)) : 7;
    easeFactor = Math.min(3, priorEase + 0.15);
  } else {
    intervalDays = priorInterval ? Math.max(4, Math.round(priorInterval * priorEase)) : 4;
  }

  const reviewed = new Date(reviewedAt);
  const next = new Date(reviewed.getTime() + intervalDays * DAY_MS);
  return {
    rating,
    interval_days: intervalDays,
    ease_factor: Number(easeFactor.toFixed(2)),
    lapses,
    reviewed_at: reviewed.toISOString(),
    next_review_date: isoDate(next),
  };
}

const PLACEHOLDER_PATTERNS = [
  /^explain (?:the|why|how)\b/i,
  /^identify (?:the|a)\b/i,
  /^write (?:why|the|a)\b/i,
  /^review (?:the|your|this)\b/i,
  /^map (?:the|this)\b/i,
  /edit before publishing/i,
  /assigned resource/i,
];

export function validateFlashcardContent(card = {}) {
  const front = String(card.front || card.question || "").trim();
  const back = String(card.back || card.answer || "").trim();
  const reasons = [];
  if (front.length < 8) reasons.push("front_too_short");
  if (back.length < 3) reasons.push("back_too_short");
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(back))) reasons.push("instruction_instead_of_answer");
  if (front.toLowerCase() === back.toLowerCase()) reasons.push("front_equals_back");
  return { valid: reasons.length === 0, reasons, front, back };
}

export function flashcardContentFingerprint(card = {}) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${normalize(card.front || card.question)}::${normalize(card.back || card.answer)}`.slice(0, 500);
}
