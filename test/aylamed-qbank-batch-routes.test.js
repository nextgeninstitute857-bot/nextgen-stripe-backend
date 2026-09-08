import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";
import { prepareAylaQbankBatch } from "../lib/aylamed-qbank-batch.js";
import { createAylaQbankSession, finalizeAylaQbankSession, canSubmitAylaQbankRoadmapSession, qbankSessionQuestion,
  sanitizeAylaQbankQuestion, sanitizeAylaQbankSession } from "../lib/aylamed-qbank.js";

// Execute the real route bodies, with only the external auth/content/store
// boundaries replaced. This catches missing response codes and submit wiring
// that pure session tests cannot observe.
function harness({ examTrack = "plab", questionPolicies = [] } = {}) {
  const questions = [1, 2].map(id => ({ id: `q${id}`, correct_answer_id: 2, explanation_html: "sealed", answers: [{ answer_id: 1 }, { answer_id: 2 }] }));
  let db = { aylaQbankSessions: { s: createAylaQbankSession({ id: "s", studentId: "student", userId: "user", examTrack, mode: "test",
    questions: questions.map((q, i) => ({ ref: `r${i + 1}`, contentQuestionId: q.id, ...questionPolicies[i] })) }) }, attempts: {} };
  const routes = new Map();
  const user = { id: "user" }, student = { id: "student" };
  const owned = (state, u, p, id) => {
    const s = state.aylaQbankSessions[id];
    if (!s || s.userId !== u.id || s.studentId !== p.id) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    return s;
  };
  const context = {
    app: { post: (path, handler) => routes.set(path, handler) },
    aylaV189RequireStudent: async (req, id) => {
      if (id !== student.id) throw Object.assign(new Error("Forbidden student"), { statusCode: 403 });
      return { db, user, student };
    },
    aylaOwnedQbankSession: owned,
    aylaRequireQbankAccess: () => {}, aylaRequireCurrentDiagnosticBlueprint: () => {},
    aylaRevalidateQbankContext: () => ({ user, student }),
    aylaSessionQbankQuestions: async (s, mappings) => questions.filter(q => mappings.some(row => row.contentQuestionId === q.id)),
    aylaDiagnosticQuestionForSession: (s, q) => q,
    mutateAylaDb: async fn => { const prepared = await mutateJsonCopyOnWrite(db, fn); db = prepared.value; return prepared.result; },
    prepareAylaQbankBatch, finalizeAylaQbankSession, canSubmitAylaQbankRoadmapSession, qbankSessionQuestion,
    aylaSetItem: (state, key, row) => { state[key][row.id] = row; },
    aylaRecordQbankAttempt: (state, s, mapping, answer) => {
      assert.equal(state.attempts[mapping.ref], undefined, "a batch retry must not record attempts again");
      state.attempts[mapping.ref] = answer;
      return { created: true };
    },
    aylaQbankEvent: () => {}, aylaV189RecordActivity: () => {},
    aylaV227RefreshWeakAreaProjection: () => ({ count: 1 }),
    aylaDateOnly: () => "2026-09-09", aylaAddDays: () => new Date(), aylaNow: () => new Date().toISOString(),
    readAylaDb: async () => db,
    sanitizeAylaQbankSession,
    aylaPlayableQbankQuestion: async (state, s, mapping, raw) => sanitizeAylaQbankQuestion(raw, { session: s, questionRef: mapping.ref }),
    aylaPlayableQbankSession: async (state, s) => ({ session: sanitizeAylaQbankSession(s), questions: questions.map((q, i) => sanitizeAylaQbankQuestion(q, { session: s, questionRef: `r${i + 1}` })) }),
    aylaSendOk: (res, body) => ({ status: 200, body }),
    aylaSendError: (res, status, message, details) => ({ status, body: { message, details } }),
  };
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/ayla/qbank/sessions/:sessionId/drafts"');
  const end = source.indexOf('app.get("/api/ayla/qbank/history"', start);
  vm.runInNewContext(source.slice(start, end), context);
  const request = (route, body, sessionId = "s") => routes.get(`/api/ayla/qbank/sessions/:sessionId/${route}`)({ params: { sessionId }, body: { student_id: "student", ...body } }, {});
  return { request, state: () => db };
}

test("real draft and submit routes seal drafts, return version conflicts, and finalize attempts once", async () => {
  const { request, state } = harness();
  const body = { idempotency_key: "draft", expected_draft_version: 0, answers: [{ question_ref: "r1", selected_answer_id: 1 }] };
  const saved = await request("drafts", body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.session.draft_version, 1);
  assert.equal(saved.body.questions[0].correct_answer_id, null);
  assert.equal(saved.body.questions.length, 1, "autosave delivers only changed questions");
  assert.equal(Object.keys(state().attempts).length, 0);
  const conflict = await request("submit", { ...body, idempotency_key: "stale-submit" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.details.code, "QBANK_DRAFT_VERSION_CONFLICT");
  const finalBody = { idempotency_key: "submit", expected_draft_version: 1, answers: [{ question_ref: "r2", selected_answer_id: 2 }] };
  const final = await request("submit", finalBody);
  assert.equal(final.status, 200);
  assert.equal(final.body.session.score_percent, 50);
  assert.equal(final.body.session.adaptation.status, "queued");
  assert.equal(Object.keys(state().attempts).length, 2);
  const replay = await request("submit", finalBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(Object.keys(state().attempts).length, 2);
});

test("real draft route refuses wrong student, foreign session and partial invalid batches", async () => {
  const { request, state } = harness();
  const body = { idempotency_key: "draft", expected_draft_version: 0, answers: [{ question_ref: "r1", selected_answer_id: 1 }] };
  assert.equal((await request("drafts", { ...body, student_id: "foreign" })).status, 403);
  assert.equal((await request("drafts", body, "foreign-session")).status, 404);
  const invalid = await request("drafts", { ...body, answers: [...body.answers, { question_ref: "r2", selected_answer_id: 9 }] });
  assert.equal(invalid.status, 400);
  assert.equal(state().aylaQbankSessions.s.draftAnswers, undefined);
});

test("batch submission keeps incomplete roadmap blocks open with no partial grading", async () => {
  const { request, state } = harness();
  Object.assign(state().aylaQbankSessions.s, { origin: "roadmap", roadmapAssignmentId: "assignment" });
  const result = await request("submit", { idempotency_key: "incomplete", expected_draft_version: 0,
    answers: [{ question_ref: "r1", selected_answer_id: 1 }] });
  assert.equal(result.status, 409);
  assert.equal(result.body.details.code, "ROADMAP_QBANK_INCOMPLETE");
  assert.equal(state().aylaQbankSessions.s.status, "in_progress");
  assert.equal(Object.keys(state().aylaQbankSessions.s.answers).length, 0);
  assert.equal(Object.keys(state().attempts).length, 0);
});

for (const scenario of [
  { name: "all scored", policies: [{}, {}], answers: [1, 2], counts: [1, 1, 0], scored: 2, supplemental: 0, score: 50 },
  { name: "partially answered", policies: [{}, {}], answers: [2], counts: [1, 0, 1], scored: 2, supplemental: 0, score: 50 },
  { name: "mixed native and supplemental", policies: [{}, { scoringAllowed: false, supplemental: true }], answers: [1, 2], counts: [0, 1, 0], scored: 1, supplemental: 1, score: 0 },
  { name: "supplemental only", policies: [{ scoringAllowed: false, supplemental: true }, { scoringAllowed: false, supplemental: true }], answers: [1, 2], counts: [0, 0, 0], scored: 0, supplemental: 2, score: null },
  { name: "unanswered", policies: [{}, {}], answers: [], counts: [0, 0, 2], scored: 2, supplemental: 0, score: 0 },
]) {
  test(`real submit route reports consistent ${scenario.name} totals and idempotent replay`, async () => {
    const { request, state } = harness({ examTrack: "mccqe", questionPolicies: scenario.policies });
    const body = { idempotency_key: `submit-${scenario.name}`, expected_draft_version: 0,
      answers: scenario.answers.map((choice, index) => ({ question_ref: `r${index + 1}`, selected_answer_id: choice })) };
    const final = await request("submit", body);
    assert.equal(final.status, 200);
    const session = final.body.session;
    assert.equal(session.status, "submitted");
    assert.equal(session.answered_count, scenario.answers.length);
    assert.equal(session.scored_question_count, scenario.scored);
    assert.equal(session.supplemental_question_count, scenario.supplemental);
    assert.deepEqual([session.correct_count, session.incorrect_count, session.unanswered_count], scenario.counts);
    assert.equal(session.correct_count + session.incorrect_count + session.unanswered_count, session.scored_question_count);
    assert.equal(session.score_percent, scenario.score);
    for (const [index, selected] of scenario.answers.entries()) {
      assert.equal(final.body.questions[index].result.correct, selected === 2);
      assert.equal(final.body.questions[index].correct_answer_id, 2);
    }
    assert.equal(Object.keys(state().attempts).length, scenario.answers.length);
    const beforeReplay = JSON.stringify(state());
    const replay = await request("submit", body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.deepEqual(replay.body.session, session);
    assert.equal(JSON.stringify(state()), beforeReplay);
  });
}
