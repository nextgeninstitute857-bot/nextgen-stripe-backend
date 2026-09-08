import test from "node:test";
import assert from "node:assert/strict";
import { prepareAylaQbankBatch } from "../lib/aylamed-qbank-batch.js";
import { createAylaQbankSession, finalizeAylaQbankSession, sanitizeAylaQbankQuestion, sanitizeAylaQbankSession } from "../lib/aylamed-qbank.js";
import { aylaQbankFilterHistory } from "../lib/aylamed-qbank-history.js";

const questions = [1, 2].map(id => ({ id: `q${id}`, correct_answer_id: 2, explanation_html: "Secret explanation", answers: [{ answer_id: 1 }, { answer_id: 2 }] }));
const session = () => createAylaQbankSession({ id: "s1", userId: "u1", studentId: "student1", examTrack: "usmle-step-1", mode: "test", questions: questions.map((q, i) => ({ ref: `r${i + 1}`, contentQuestionId: q.id })) });
const body = (version = 0, key = "save1", choice = 1) => ({ expected_draft_version: version, idempotency_key: key, answers: [{ question_ref: "r1", selected_answer_id: choice, elapsed_ms: 100 }] });
const prepare = (s, b, operation = "drafts") => prepareAylaQbankBatch(s, { body: b, operation, questions });

test("draft save is editable and sealed; one submission grades all saved drafts", () => {
  const original = session();
  const first = prepare(original, body()).session;
  assert.deepEqual(original.answers, {});
  assert.equal(original.draftAnswers, undefined);
  assert.deepEqual(first.answers, {});
  const safe = sanitizeAylaQbankQuestion(questions[0], { session: first, questionRef: "r1" });
  assert.equal(safe.selected_answer_id, 1);
  assert.equal(safe.draft_saved, true);
  assert.equal(safe.explanation_html, null);
  assert.equal(safe.correct_answer_id, null);
  assert.equal(safe.result, null);
  const edited = prepare(first, body(1, "save2", 2)).session;
  const ready = prepare(edited, { ...body(2, "submit"), answers: [{ question_ref: "r2", selected_answer_id: 1 }] }, "submit").session;
  const final = finalizeAylaQbankSession(ready).session;
  assert.equal(final.scorePercent, 50);
  assert.deepEqual(final.draftAnswers, {});
  assert.equal(Object.keys(final.answers).length, 2);
  assert.equal(sanitizeAylaQbankSession(final).draft_version, 3);
  assert.equal(sanitizeAylaQbankQuestion(questions[0], { session: final, questionRef: "r1" }).correct_answer_id, 2);
});

test("invalid or foreign choices reject the whole batch without partial changes", () => {
  for (const invalid of [{ question_ref: "r2", selected_answer_id: 99 }, { question_ref: "other-session", selected_answer_id: 1 }, { question_ref: "r1", selected_answer_id: 2 }]) {
    const original = session(), before = JSON.stringify(original);
    assert.throws(() => prepare(original, { ...body(), answers: [...body().answers, invalid] }));
    assert.equal(JSON.stringify(original), before);
  }
});

test("cross-device versions and idempotency prevent lost edits or duplicate grading", () => {
  const saved = prepare(session(), body()).session;
  assert.equal(prepare(saved, body()).replayed, true);
  assert.throws(() => prepare(saved, body(0, "second-tab")), { code: "QBANK_DRAFT_VERSION_CONFLICT" });
  assert.throws(() => prepare(saved, body(0, "save1", 2)), { code: "QBANK_IDEMPOTENCY_CONFLICT" });
  const request = { ...body(1, "final"), answers: [] };
  const final = finalizeAylaQbankSession(prepare(saved, request, "submit").session).session;
  assert.equal(prepare(final, request, "submit").replayed, true);
  assert.equal(finalizeAylaQbankSession(prepare(final, request, "submit").session).replayed, true);
  assert.throws(() => prepare(final, body(2, "too-late")), { code: "QBANK_SESSION_CLOSED" });
});

test("baseline and tutor preserve existing controlled answer flow; draft submission needs a version", () => {
  assert.throws(() => prepare({ ...session(), purpose: "baseline_diagnostic" }, body()), { code: "QBANK_DRAFTS_UNAVAILABLE" });
  assert.throws(() => prepare({ ...session(), mode: "tutor" }, body()), { code: "QBANK_DRAFTS_UNAVAILABLE" });
  const baseline = { ...session(), purpose: "baseline_diagnostic" };
  assert.equal(prepare(baseline, {}, "submit").session, baseline);
  assert.throws(() => prepare(prepare(session(), body()).session, {}, "submit"));
});

test("bounded receipts cannot permit an old request to replace newer choices", () => {
  let s = session();
  for (let i = 0; i < 70; i++) s = prepare(s, body(i, `save-${i}`)).session;
  assert.equal(s.batchReceipts.length, 64);
  assert.throws(() => prepare(s, body(0, "save-0")), { code: "QBANK_DRAFT_VERSION_CONFLICT" });
});

test("status filters cannot expose unsubmitted test correctness or other students", () => {
  const sealed = prepare(prepare(session(), body()).session, { ...body(1, "grade"), answers: [] }, "submit").session;
  const scope = { userId: "u1", studentId: "student1", examTrack: "usmle-step-1" };
  assert.deepEqual(aylaQbankFilterHistory([sealed], scope).incorrectQuestionIds, []);
  const final = finalizeAylaQbankSession(sealed).session;
  assert.deepEqual(aylaQbankFilterHistory([final, { ...final, studentId: "someone-else" }], scope).incorrectQuestionIds, ["q1"]);
  assert.deepEqual(aylaQbankFilterHistory([final], { ...scope, examTrack: "plab" }).seenQuestionIds, []);
});
