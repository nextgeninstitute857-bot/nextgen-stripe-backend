import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("tomorrow preview is summary-only and never builds or hydrates a future plan", () => {
  const start = server.indexOf("function aylaV189TomorrowPreview");
  const end = server.indexOf("\nfunction aylaV213TutorStudentRows", start);
  assert.ok(start >= 0 && end > start);
  const preview = server.slice(start, end);
  assert.doesNotMatch(preview, /aylaV189BuildDailyPlan/);
  assert.doesNotMatch(preview, /aylaV251HydrateAssignmentMedia/);
  assert.doesNotMatch(preview, /JSON\.parse\(JSON\.stringify/);
  assert.match(preview, /Tomorrow adapts after today/);
});

test("compact Today workspace returns before history scans and media signing", () => {
  const start = server.indexOf('app.get("/api/ayla/students/:studentId/daily-workspace"');
  const end = server.indexOf('\napp.post("/api/ayla/students/:studentId/daily-workspace/rebuild"', start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  const compactBranch = route.indexOf("if (compactTodayView)");
  const fullSystemProgress = route.indexOf("const systemProgress = aylaV189SystemProgress", compactBranch);
  const firstHistoryScan = route.indexOf('aylaValues(db, "aylaActivityHistory")');
  assert.ok(compactBranch >= 0 && firstHistoryScan > compactBranch);
  assert.ok(fullSystemProgress > compactBranch && firstHistoryScan > fullSystemProgress);
  const compactPath = route.slice(compactBranch, firstHistoryScan);
  assert.doesNotMatch(route, /writeAylaDb\(db\)/);
  assert.match(route, /mutateAylaRoadmapState/);
  assert.match(route, /skipAi: true/);
  assert.match(compactPath, /aylaV189SanitizePlanBundle\(db, built\.plan, built\.assignments\)/);
  assert.match(compactPath, /systemProgress: \[\]/);
  assert.doesNotMatch(route.slice(compactBranch, fullSystemProgress), /aylaV189SystemProgress|aylaV189BacklogWarning/);
  assert.doesNotMatch(compactPath, /aylaV251HydrateAssignmentMedia/);
  assert.match(route, /req\.query\.view/);
});

test("first-time roadmap plans never load the legacy CRM training snapshot", () => {
  const start = server.indexOf("async function aylaV189BuildDailyPlan");
  const end = server.indexOf("\nfunction aylaV189UpdatePlanCompletion", start);
  assert.ok(start >= 0 && end > start);
  const planner = server.slice(start, end);
  assert.match(planner, /aylaV211EligibleReadings\(db, student, \{ allowLegacyCrm: false \}\)/);
  assert.doesNotMatch(planner, /aylaV211EligibleReadings\(db, student\)(?!,)/);
});

test("roadmap journaling clones only its three writable collections", () => {
  const start = server.indexOf("async function mutateAylaRoadmapState");
  const end = server.indexOf("\nasync function readAylaCrmSnapshot", start);
  assert.ok(start >= 0 && end > start);
  const mutation = server.slice(start, end);
  assert.match(mutation, /Object\.fromEntries\(AYLA_ROADMAP_STATE_COLLECTIONS\.map/);
  assert.match(mutation, /Roadmap journal mutations cannot delete/);
  assert.doesNotMatch(mutation, /mutateJsonCopyOnWrite/);
});
