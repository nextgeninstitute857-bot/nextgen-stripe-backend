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
function harness() {
  const questions = [1, 2].map(id => ({ id: `q${id}`, correct_answer_id: 2, explanation_html: "sealed", answers: [{ answer_id: 1 }, { answer_id: 2 }] }));
  let db = { aylaQbankSessions: { s: createAylaQbankSession({ id: "s", studentId: "student", userId: "user", examTrack: "plab", mode: "test",
    questions: questions.map((q, i) => ({ ref: `r${i + 1}`, contentQuestionId: q.id })) }) }, attempts: {} };
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
    aylaSessionQbankQuestions: async () => questions,
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
