import { createHash } from "node:crypto";
import { recordAylaQbankAnswer } from "./aylamed-qbank.js";

function fail(message, statusCode = 400, code = "INVALID_QBANK_BATCH") {
  throw Object.assign(new Error(message), { statusCode, code });
}

// Pure preparation: validate the entire batch before returning new session state.
// The route persists it and its receipt together in one durable mutation.
export function prepareAylaQbankBatch(session, { operation = "drafts", body = {}, questions = [], now = new Date() } = {}) {
  const hasAnswers = Object.hasOwn(body, "answers");
  if (operation === "submit" && !hasAnswers && !Object.keys(session.draftAnswers || {}).length) {
    return { session, replayed: session.status === "submitted" };
  }
  if (session.mode !== "test" || session.purpose === "baseline_diagnostic") {
    fail("Batch drafts are available only in ordinary test sessions", 409, "QBANK_DRAFTS_UNAVAILABLE");
  }
  if (!Array.isArray(body.answers) || body.answers.length > 200) fail("answers must contain at most 200 answer choices");
  const key = body.idempotency_key;
  if (typeof key !== "string" || !key.trim() || key.length > 120) fail("A valid idempotency_key is required");
  const expected = body.expected_draft_version;
  if (!Number.isSafeInteger(expected) || expected < 0) fail("expected_draft_version is required");
  const mappings = new Map((session.questions || []).map(row => [String(row.ref), row]));
  const byId = new Map(questions.map(row => [String(row.id), row]));
  const refs = new Set();
  const answers = body.answers.map(row => {
    if (!row || typeof row.question_ref !== "string" || !mappings.has(row.question_ref)) {
      fail("Question does not belong to this QBank session", 404, "QBANK_QUESTION_NOT_FOUND");
    }
    if (refs.has(row.question_ref)) fail("A question may appear only once in a batch");
    refs.add(row.question_ref);
    const question = byId.get(String(mappings.get(row.question_ref).contentQuestionId));
    if (!question) fail("A question is temporarily unavailable; your saved answers remain intact", 409, "QBANK_QUESTION_UNAVAILABLE");
    if (!Number.isInteger(row.selected_answer_id) || !(question.answers || []).some(choice => Number(choice.answer_id ?? choice.answerId) === row.selected_answer_id)) {
      fail("A valid answer choice is required");
    }
    if (row.elapsed_ms != null && (!Number.isFinite(row.elapsed_ms) || row.elapsed_ms < 0 || row.elapsed_ms > 86400000)) fail("elapsed_ms must be between 0 and 86400000");
    return { question_ref: row.question_ref, selected_answer_id: row.selected_answer_id, elapsed_ms: row.elapsed_ms ?? null };
  }).sort((a, b) => a.question_ref.localeCompare(b.question_ref));
  const fingerprint = createHash("sha256").update(JSON.stringify({ operation, expected, answers })).digest("hex");
  const receipt = (session.batchReceipts || []).find(row => row.key === key);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail("Idempotency key was used for a different answer batch", 409, "QBANK_IDEMPOTENCY_CONFLICT");
    return { session, replayed: true };
  }
  if (session.status !== "in_progress") fail("This QBank session is already closed", 409, "QBANK_SESSION_CLOSED");
  if (expected !== Number(session.draftVersion || 0)) fail("Answers changed in another tab. Reload saved answers before continuing.", 409, "QBANK_DRAFT_VERSION_CONFLICT");
  const timestamp = new Date(now).toISOString();
  const draftAnswers = { ...(session.draftAnswers || {}) };
  for (const row of answers) {
    const locked = session.answers?.[row.question_ref];
    if (locked && Number(locked.selectedAnswerId) !== row.selected_answer_id) fail("An answer saved by an earlier test version is locked", 409, "QBANK_ANSWER_LOCKED");
    if (!locked) draftAnswers[row.question_ref] = { selectedAnswerId: row.selected_answer_id, elapsedMs: row.elapsed_ms, savedAt: timestamp };
  }
  let next = { ...session, draftAnswers, draftVersion: expected + 1, updatedAt: timestamp };
  if (operation === "submit") {
    for (const [questionRef, draft] of Object.entries(draftAnswers)) {
      const mapping = mappings.get(questionRef);
      const question = byId.get(String(mapping?.contentQuestionId));
      if (!question || !(question.answers || []).some(choice => Number(choice.answer_id ?? choice.answerId) === draft.selectedAnswerId) || !Number.isInteger(Number(question.correct_answer_id))) {
        fail("A saved question needs review before this test can be submitted", 409, "QBANK_QUESTION_UNAVAILABLE");
      }
      next = recordAylaQbankAnswer(next, { questionRef, selectedAnswerId: draft.selectedAnswerId, correctAnswerId: Number(question.correct_answer_id), elapsedMs: draft.elapsedMs, now }).session;
    }
    next.draftAnswers = {};
  }
  // Old receipts can be bounded because every new request also checks the durable
  // draft version. An evicted, delayed request cannot overwrite newer answers.
  next.batchReceipts = [...(session.batchReceipts || []), { key, fingerprint, operation, version: next.draftVersion, savedAt: timestamp }].slice(-64);
  return { session: next, replayed: false };
}
