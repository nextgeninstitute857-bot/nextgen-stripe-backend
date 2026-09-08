import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { projectStudentQbankStem, projectStudentQbankHintMedia } from "../lib/aylamed-qbank-student-html.js";
import { sanitizeImportedHtml } from "../lib/content-import-adapter.js";
import { questionTaxonomyEvidenceFingerprint } from "../lib/content-question-taxonomy-review.js";
import { createAylaQbankSession, sanitizeAylaQbankQuestion, sanitizeAylaQbankSession } from "../lib/aylamed-qbank.js";
import { sanitizeExternalQbankQuestion } from "../lib/external-qbank-delivery.js";

const before = '<table class="labs"><tr><td>α &amp; β</td><td>4 &lt; 5</td></tr></table>';
const after = '<p>Choose the next step.</p><table><tr><td>Follow-up</td></tr></table>';
const hint = '<button onclick="showHint()"><span>Show Hint</span></button><div id="hintdiv" style="display:none"><div><p>SEALED_HINT <b>with nested markup</b></p><table><tr><td>SEALED_TABLE</td></tr></table></div><p>SEALED_TAIL</p></div>';

test("student projection removes nested imported hints and controls, preserving surrounding source bytes", () => {
  const imported = sanitizeImportedHtml(before + hint + after);
  assert.match(imported, /SEALED_HINT/); // Import/admin evidence deliberately remains complete.
  const projected = projectStudentQbankStem(imported);
  assert.equal(projected.html, before + after);
  assert.match(projected.removedHtml, /SEALED_TAIL/);
  assert.doesNotMatch(projected.html, /hint|SEALED/i);
  assert.equal(projectStudentQbankStem(projected.html).html, projected.html);
});

test("HTML parsing handles encoded/unquoted IDs, quoted angles, repeated hints, template and unclosed hint nodes", () => {
  for (const attrs of ['ID=hintdiv', 'id="hint&#100;iv"', "id='HiNtDiV' data-value='x > y'"]) {
    const input = before + '<strong>Show&nbsp;Hint</strong>' + `<div ${attrs}><div>SEALED_HINT</div></div>` + after;
    assert.equal(projectStudentQbankStem(input).html, before + after);
  }
  assert.equal(projectStudentQbankStem(before + hint + hint + after).html, before + after);
  assert.equal(projectStudentQbankStem(before + '<template><div id=hintdiv>SEALED_HINT</div></template>' + after).html,
    before + '<template></template>' + after);
  assert.equal(projectStudentQbankStem(before + '<div id=hintdiv><div>SEALED_HINT</div>SEALED_TAIL').html, before);
  for (const ordinary of [before + after, '<strong>Show Hint</strong><p>No provider widget.</p>',
    '<p id="hintdiv-example">A clinical hint in the history.</p>', '<p>hintdiv is ordinary text.</p>']) {
    assert.equal(projectStudentQbankStem(ordinary).html, ordinary);
  }
});

function rawQuestion() {
  return {
    id: "q1", exam_track: "usmle-step-2", title: "Synthetic practice item",
    question_html: sanitizeImportedHtml(before + hint + after),
    explanation_html: '<p>Complete explanation remains available after grading.</p><div id="hintdiv">Explanation detail.</div>',
    correct_answer_id: 2,
    answers: [{ answer_id: 1, text_html: "Choice A" }, { answer_id: 2, text_html: "Choice B" }],
    media: [], videos: [],
  };
}

function session(mode, status = "in_progress") {
  return { ...createAylaQbankSession({ id: "s1", studentId: "student", userId: "user", examTrack: "usmle-step-2", mode,
    questions: [{ ref: "r1", contentQuestionId: "q1" }] }), status };
}

function assertSafe(dto, raw, reveal) {
  assert.equal(dto.question_html, before + after);
  assert.doesNotMatch(JSON.stringify(dto), /SEALED_|Show Hint/);
  assert.deepEqual(dto.answers.map(({ answer_id, text_html }) => ({ answer_id, text_html })), raw.answers);
  assert.equal(dto.correct_answer_id, reveal ? 2 : null);
  assert.equal(dto.explanation_html, reveal ? raw.explanation_html : null);
}

test("shared DTO seals unanswered, drafted and answered Test stems; Tutor and submitted explanations keep normal gating", () => {
  const raw = rawQuestion();
  const snapshot = structuredClone(raw);
  const evidenceFingerprint = questionTaxonomyEvidenceFingerprint(raw);
  for (const mode of ["test", "tutor"]) {
    const current = session(mode);
    assertSafe(sanitizeAylaQbankQuestion(raw, { session: current, questionRef: "r1" }), raw, false);
    current.draftAnswers = { r1: { selectedAnswerId: 1 } };
    assertSafe(sanitizeAylaQbankQuestion(raw, { session: current, questionRef: "r1" }), raw, false);
    current.answers = { r1: { selectedAnswerId: 1, correctAnswerId: 2, correct: false } };
    assertSafe(sanitizeAylaQbankQuestion(raw, { session: current, questionRef: "r1" }), raw, mode === "tutor");
    current.status = "submitted";
    assertSafe(sanitizeAylaQbankQuestion(raw, { session: current, questionRef: "r1" }), raw, true);
  }
  assert.deepEqual(raw, snapshot);
  assert.equal(questionTaxonomyEvidenceFingerprint(raw), evidenceFingerprint);
});

test("hint-only media and video do not escape through separate galleries; shared clinical/explanation media survives", () => {
  const raw = rawQuestion();
  raw.question_html = before + '<img src="shared.jpg"><div id="hintdiv"><img src="secret.jpg"><img src="shared.jpg"><img src="explain.jpg"><a href="https://vimeo.com/123456">Hint video</a></div>' + after;
  raw.explanation_html = '<img src="explain.jpg"><p>Explanation</p>';
  raw.media = ["secret", "shared", "explain"].map(id => ({ id, ref: `${id}.jpg`, placement: "question", url: `https://private.test/${id}` }));
  raw.videos = [{ id: "v1", ref: "hint-video", provider: "vimeo", provider_id: "123456", placement: "question", embed_url: "https://player.vimeo.com/video/123456" }];
  const snapshot = structuredClone(raw);
  const hidden = sanitizeAylaQbankQuestion(raw, { session: session("test"), questionRef: "r1" });
  assert.deepEqual(hidden.media.map(item => item.id), ["shared"]);
  assert.equal(hidden.videos.length, 0);
  assert.doesNotMatch(JSON.stringify(hidden), /secret\.jpg|123456|private.test\/secret|explain\.jpg/);
  const revealed = sanitizeAylaQbankQuestion(raw, { session: session("test", "submitted"), questionRef: "r1" });
  assert.deepEqual(revealed.media.map(item => [item.id, item.placement]), [["shared", "question"], ["explain", "explanation"]]);
  assert.equal(revealed.explanation_html, raw.explanation_html);
  assert.deepEqual(raw, snapshot);
});

test("same-basename figures in different folders retain the clinical figure without leaking the hint figure", () => {
  const raw = rawQuestion();
  raw.question_html = '<img src="question/figure.jpg"><div id="hintdiv"><img src="hint/figure.jpg"></div>';
  raw.media = ["question", "hint"].map(id => ({ id, ref: `${id}/figure.jpg`, placement: "question", url: `https://private.test/${id}` }));
  const dto = sanitizeAylaQbankQuestion(raw, { session: session("test"), questionRef: "r1" });
  assert.deepEqual(dto.media.map(item => item.id), ["question"]);
  assert.equal(dto.question_html, '<img src="question/figure.jpg">');
  assert.doesNotMatch(JSON.stringify(dto), /hint\/figure|private.test\/hint/);
});

test("actual session GET and delivery closure remove hints on cached-session reopen in both modes", async () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const raw = rawQuestion();
  const snapshot = structuredClone(raw);
  const routes = new Map();
  let current;
  const context = {
    app: { get: (route, handler) => routes.set(route, handler) },
    normalizeAylaRegistryExamTrack: value => value,
    getContentQbankQuestions: async () => [raw],
    createPrivateMediaUrl: async () => "https://private.test/synthetic",
    aylaDiagnosticQuestionForSession: (s, q) => q,
    aylaQbankQuestionState: () => ({}),
    aylaRequireCurrentDiagnosticBlueprint: () => {},
    aylaRequireQbankAccess: () => {},
    aylaV189RequireStudent: async () => ({ db: {}, user: { id: "user" }, student: { id: "student" } }),
    aylaOwnedQbankSession: () => current,
    sanitizeAylaQbankQuestion, sanitizeAylaQbankSession,
    aylaSendOk: (res, body) => ({ status: 200, body }),
    aylaSendError: (res, status, message) => ({ status, message }),
  };
  const mediaStart = source.indexOf("async function ngRegistryQuestionWithPlayableMedia(");
  vm.runInNewContext(source.slice(mediaStart, source.indexOf('\napp.post(', mediaStart)), context);
  const deliveryStart = source.indexOf("async function aylaSessionQbankQuestions(");
  vm.runInNewContext(source.slice(deliveryStart, source.indexOf("\nfunction aylaOwnerId(", deliveryStart)), context);
  const routeStart = source.indexOf('app.get("/api/ayla/qbank/sessions/:sessionId"');
  vm.runInNewContext(source.slice(routeStart, source.indexOf('\napp.post(', routeStart)), context);
  for (const mode of ["test", "tutor"]) {
    // Durable old sessions contain references, and must receive the new projection
    // even though they were created before this code was deployed.
    current = JSON.parse(JSON.stringify(session(mode)));
    const response = await routes.get("/api/ayla/qbank/sessions/:sessionId")({ params: { sessionId: "s1" }, query: { student_id: "student" } }, {});
    assert.equal(response.status, 200, response.message);
    assertSafe(response.body.questions[0], raw, false);
    assert.equal(response.body.session.answered_count, 0);
    const item = await context.aylaPlayableQbankQuestion({}, current, current.questions[0], raw);
    assertSafe(item, raw, false); // Shared create/answer/saved-item delivery boundary.
  }
  assert.deepEqual(raw, snapshot);
});

test("external QBank wrapper uses the same student-only projection", () => {
  const raw = rawQuestion();
  for (const mode of ["test", "tutor"]) {
    const dto = sanitizeExternalQbankQuestion(raw, { id: "s1", mode, status: "in_progress", questions: [], answers: {} }, { question_ref: "r1" });
    assertSafe(dto, raw, false);
  }
});

test("actual CDM delivery projects unlocked stems and preserves response/explanation gating and locked steps", async () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const raw = rawQuestion();
  raw.question_html = before + '<div id="hintdiv">SEALED_HINT<img src="secret.jpg"></div>' + after;
  raw.media = [{ id: "secret", ref: "secret.jpg", placement: "question", url: "https://private.test/secret" }];
  const sourceCase = { case_id: "case1", steps: [raw, { ...raw, id: "q2" }] };
  const snapshot = structuredClone(sourceCase);
  const context = {
    getContentCdmCase: async () => sourceCase,
    ngRegistryQuestionWithPlayableMedia: async question => question,
    sanitizeAylaCdmSession: current => ({ id: current.id }),
    aylaCdmLegacyNotice: () => ({ legacy_exam_format: true }),
    projectStudentQbankStem, projectStudentQbankHintMedia,
  };
  const start = source.indexOf("async function aylaPlayableCdmSession(");
  vm.runInNewContext(source.slice(start, source.indexOf("\nfunction aylaUpsertCdmRevision(", start)), context);
  const current = { id: "cdm1", caseId: "case1", examTrack: "mccqe", currentStepIndex: 0,
    steps: [{ ref: "r1", contentQuestionId: "q1" }, { ref: "r2", contentQuestionId: "q2" }], responses: {} };
  const beforeAnswer = await context.aylaPlayableCdmSession({}, current);
  assert.equal(beforeAnswer.case.steps[0].question_html, before + after);
  assert.equal(beforeAnswer.case.steps[0].explanation_html, null);
  assert.equal(beforeAnswer.case.steps[0].response_locked, false);
  assert.equal(beforeAnswer.case.steps[0].media.length, 0);
  assert.equal(beforeAnswer.case.steps[1].locked, true);
  assert.equal(beforeAnswer.case.steps[1].question_html, undefined);
  assert.doesNotMatch(JSON.stringify(beforeAnswer), /SEALED_|private.test\/secret/);
  current.responses.r1 = { responses: ["Synthetic response"], responseCount: 1, maxResponses: 1 };
  const afterAnswer = await context.aylaPlayableCdmSession({}, current);
  assert.equal(afterAnswer.case.steps[0].question_html, before + after);
  assert.equal(afterAnswer.case.steps[0].explanation_html, raw.explanation_html);
  assert.equal(afterAnswer.case.steps[0].response_locked, true);
  assert.deepEqual(sourceCase, snapshot);
  // The projection does not reopen this retired exam format.
  assert.match(source, /app\.use\("\/api\/ayla\/cdm",[\s\S]*?410,/);
});
