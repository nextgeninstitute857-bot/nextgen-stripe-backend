import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("async function aylaV189BuildDailyPlan");
const end = server.indexOf("\nfunction aylaV189UpdatePlanCompletion", start);
const planner = server.slice(start, end);

test("verified scored work is reserved before optional new content", () => {
  const qbank = planner.indexOf('"internal_mcqs", pick');
  const reading = planner.indexOf("if (!plan.finalReviewMode && mix.reading");
  const video = planner.indexOf("if (!plan.finalReviewMode && mix.video");
  assert.ok(qbank > 0 && qbank < reading && reading < video);
  assert.match(planner.slice(qbank, reading), /allowOverCapacity: true/);
});

test("final review opens no broad new reading, video, external IDs, or generic cards", () => {
  assert.match(planner, /finalReviewMode/);
  assert.match(planner, /!plan\.finalReviewMode && mix\.reading/);
  assert.match(planner, /!plan\.finalReviewMode && mix\.video/);
  assert.match(planner, /!plan\.finalReviewMode && mix\.external_questions/);
  assert.match(planner, /!plan\.finalReviewMode && mix\.flashcards/);
  assert.match(planner, /Final review is active/);
});

test("assessment timing is evaluated from the requested study date", () => {
  const decisionStart = server.indexOf("function aylaV189AssessmentDecision");
  const decisionEnd = server.indexOf("\nfunction aylaV189SmartAssessmentResource", decisionStart);
  const decision = server.slice(decisionStart, decisionEnd);
  assert.match(decision, /planningDate/);
  assert.match(decision, /aylaV189DaysBetween\(planningDate, target\.targetDate\)/);
});

test("legacy focus mismatches use a transparent verified exam-wide QBank fallback", () => {
  const eligibleStart = server.indexOf("async function aylaV250EligibleQbankQuestions");
  const eligibleEnd = server.indexOf("\nasync function aylaV250EligibleCdmCases", eligibleStart);
  const eligible = server.slice(eligibleStart, eligibleEnd);
  assert.match(eligible, /matchLevel/);
  assert.match(eligible, /"exam_wide"/);
  assert.match(planner, /registryQbank\.matchLevel === "exam_wide"/);
});
