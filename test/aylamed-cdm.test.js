import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  canCompleteAylaCdmSession,
  cdmRoadmapAssignmentEligible,
  cdmRoadmapSessionMatchesAssignment,
  createAylaCdmSession,
  finalizeAylaCdmSession,
  normalizeAylaCdmResponses,
  recordAylaCdmResponse,
  recordAylaCdmSelfReview,
  sanitizeAylaCdmSession,
} from "../lib/aylamed-cdm.js";

function session() {
  return createAylaCdmSession({
    id: "AYLA-CDM-1",
    userId: "user-1",
    studentId: "student-1",
    examTrack: "mccqe",
    caseId: "case-1",
    caseTitle: "Case 1",
    origin: "roadmap",
    roadmapAssignmentId: "assignment-1",
    steps: [
      { ref: "step-a", contentQuestionId: "question-a", maxResponses: 2 },
      { ref: "step-b", contentQuestionId: "question-b", maxResponses: 1 },
    ],
    now: "2026-07-26T10:00:00.000Z",
  });
}

test("CDM responses are one clinical action per unique line", () => {
  assert.deepEqual(
    normalizeAylaCdmResponses("Order ECG\nGive aspirin"),
    ["Order ECG", "Give aspirin"],
  );
  assert.throws(
    () => normalizeAylaCdmResponses(["Order ECG", "order ecg"]),
    { code: "DUPLICATE_CDM_RESPONSE" },
  );
});

test("CDM enforces sequential reveal and records over-limit practice", () => {
  const state = session();
  assert.throws(
    () => recordAylaCdmResponse(state, {
      stepRef: "step-b",
      responses: ["Later step"],
      confidence: "confident",
    }),
    { code: "CDM_STEP_SEQUENCE_LOCKED" },
  );

  const recorded = recordAylaCdmResponse(state, {
    stepRef: "step-a",
    responses: ["First action", "Second action", "Third action"],
    confidence: "not_sure",
    now: "2026-07-26T10:01:00.000Z",
  });
  assert.equal(recorded.response.overLimit, true);
  assert.equal(recorded.response.maxResponses, 2);
  assert.equal(canCompleteAylaCdmSession(state), false);

  const reviewed = recordAylaCdmSelfReview(state, {
    stepRef: "step-a",
    marks: ["correct", "not_acceptable", "dangerous_act"],
    now: "2026-07-26T10:02:00.000Z",
  });
  assert.equal(reviewed.review.needsRevision, true);
  assert.equal(reviewed.review.dangerousActCount, 1);
  assert.equal(state.currentStepIndex, 1);
});

test("CDM completion is self-reviewed evidence and never a scored MCQ result", () => {
  const state = session();
  recordAylaCdmResponse(state, {
    stepRef: "step-a",
    responses: ["First", "Second"],
    confidence: "confident",
  });
  recordAylaCdmSelfReview(state, {
    stepRef: "step-a",
    marks: ["correct", "correct"],
  });
  recordAylaCdmResponse(state, {
    stepRef: "step-b",
    responses: ["Third"],
    confidence: "not_sure",
  });
  recordAylaCdmSelfReview(state, {
    stepRef: "step-b",
    marks: ["not_acceptable"],
  });
  const result = finalizeAylaCdmSession(state, "2026-07-26T10:15:00.000Z");
  const publicSession = sanitizeAylaCdmSession(result.session);
  assert.equal(publicSession.status, "completed");
  assert.equal(publicSession.score_percent, null);
  assert.equal(publicSession.server_verified_score, false);
  assert.equal(publicSession.summary.evidenceType, "student_self_reviewed_legacy_cdm_practice");
  assert.equal(publicSession.summary.revisionNeeded, true);
});

test("CDM roadmap assignment is bound to the exact case", () => {
  const assignment = {
    id: "assignment-1",
    category: "cdm_case",
    cdmCaseId: "case-1",
  };
  assert.equal(cdmRoadmapAssignmentEligible(assignment), true);
  assert.equal(cdmRoadmapSessionMatchesAssignment(session(), assignment), true);
  assert.equal(cdmRoadmapAssignmentEligible({ category: "qbank", resourceIds: ["case-1"] }), false);
});

test("server keeps CDM delivery separate from QBank scoring and binds it to roadmap completion", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf('app.get("/api/ayla/cdm/catalog"');
  const end = server.indexOf('app.get("/admin/crm/ai-training"', start);
  assert.ok(start > 0 && end > start);
  const routes = server.slice(start, end);
  for (const endpoint of [
    "/api/ayla/cdm/catalog",
    "/api/ayla/cdm/sessions",
    "/api/ayla/cdm/sessions/:sessionId/responses",
    "/api/ayla/cdm/sessions/:sessionId/reviews",
    "/api/ayla/cdm/sessions/:sessionId/complete",
    "/api/ayla/cdm/history",
  ]) {
    assert.match(routes, new RegExp(endpoint.replace(/[/:]/g, "\\$&")));
  }
  assert.match(routes, /cdmRoadmapSessionMatchesAssignment/);
  assert.match(routes, /student_self_reviewed_legacy_cdm_practice/);
  assert.match(routes, /scoreGenerated:\s*false/);
  assert.doesNotMatch(routes, /recordAylaQbankAnswer|finalizeAylaQbankSession|correctAnswerId/);
});
