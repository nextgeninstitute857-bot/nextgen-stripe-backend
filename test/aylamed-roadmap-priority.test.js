import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("async function aylaV189BuildDailyPlan");
const end = server.indexOf("\nfunction aylaV189UpdatePlanCompletion", start);
const planner = server.slice(start, end);

test("verified scored work is reserved before optional new content", () => {
  const qbank = planner.indexOf('"internal_mcqs", pick');
  const external = planner.indexOf("if (balancePolicy.enabled) scheduleExternalQuestions()");
  const video = planner.indexOf("if (mix.video !== false && contentHubEnabled)");
  const reading = planner.indexOf("if (balancePolicy.enabled) scheduleReading()");
  assert.ok(qbank > 0 && qbank < external && external < video && video < reading);
  assert.match(planner.slice(qbank, external), /allowOverCapacity: !balancePolicy\.enabled/);
  assert.match(planner, /buildAylaRoadmapBalancePolicy/);
  assert.match(planner, /priorityCarryCapMinutes/);
  assert.match(planner, /filter\(\(\{ category \}\) => category === "flashcards"\)/);
  assert.match(planner, /groupedRevision = true/);
  assert.match(planner, /overdueFlashcardGroups/);
  assert.match(planner, /linkedAssignmentIds = selectedOverdueFlashcards/);
  assert.match(planner, /individualOverdue = balancePolicy\.enabled/);
});

test("final review keeps scored work first while permitting only matched support", () => {
  assert.match(planner, /finalReviewMode/);
  assert.match(planner, /const finalReviewReadingAllowed = !plan\.finalReviewMode/);
  assert.match(planner, /selection\.resumed/);
  assert.match(planner, /selection\.match_level === "exact_topic"/);
  assert.match(planner, /if \(mix\.video !== false && contentHubEnabled\)/);
  assert.match(planner, /plan\.finalReviewMode \|\| mix\.external_questions === false/);
  assert.match(planner, /if \(mix\.flashcards !== false\)/);
  assert.match(planner, /targeted final-review support/);
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

test("active MCCQE plans upgrade once while completed history remains protected", () => {
  const completedGuard = planner.indexOf('String(existing.status || "").toLowerCase() === "completed"');
  const upgradeGuard = planner.indexOf("const balanceUpgradeRequired");
  const reuseGuard = planner.indexOf("if (existing && !forceRebuild)");
  assert.ok(completedGuard > 0 && completedGuard < upgradeGuard && upgradeGuard < reuseGuard);
  assert.match(planner, /AYLA_MCCQE_ROADMAP_BALANCE_VERSION/);
  assert.match(planner, /forceRebuild = options\.force \|\| verifiedDiagnosticPlanCanYield \|\| balanceUpgradeRequired/);
});
